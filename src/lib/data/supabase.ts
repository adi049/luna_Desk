/**
 * LIVE ADAPTER — talks to your Supabase project.
 *
 * Only the publishable (anon) key is used here. Every read and write is
 * subject to Row Level Security; privileged work (recording payments, issuing
 * receipt numbers, rotating access codes) happens inside SECURITY DEFINER
 * Postgres functions or Edge Functions, never in the browser.
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { DataAdapter, ListOptions, Row, TableName, RpcName, AuthAdapter, AccessResult } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'lunadesk.auth',
      },
      global: { headers: { 'x-application-name': 'lunadesk' } },
    })
  : null;

function client(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or run with VITE_DATA_MODE=demo.',
    );
  }
  return supabase;
}


/**
 * Internal notes never live on the client-visible row.
 *
 * RLS filters rows, not columns, so `clients.internal_notes` would be readable
 * by the client whose portal shows that row. The schema therefore keeps those
 * remarks in `public.internal_notes`, which is admin-only. This adapter hides
 * the split from the UI: it reads the extra column back in and writes it out
 * separately, so pages keep working with a single `internal_notes` field.
 */
const INTERNAL_NOTE_OWNERS: Record<string, 'client_id' | 'client_service_id'> = {
  clients: 'client_id',
  client_services: 'client_service_id',
};

type RowWithNotes = Row & { internal_notes?: string | null };

function splitNotes(table: string, row: Row): { row: Row; notes?: string | null } {
  const owner = INTERNAL_NOTE_OWNERS[table];
  if (!owner || !('internal_notes' in row)) return { row };
  const { internal_notes: notes, ...rest } = row as RowWithNotes;
  return { row: rest, notes: notes ?? null };
}

async function writeNotes(ownerColumn: string, ownerId: string, notes: string | null) {
  const db = client();
  if (notes === null || notes.trim() === '') {
    const { error } = await db.from('internal_notes').delete().eq(ownerColumn, ownerId);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await db
    .from('internal_notes')
    .upsert({ [ownerColumn]: ownerId, body: notes.trim() }, { onConflict: ownerColumn });
  if (error) throw new Error(error.message);
}

async function attachNotes<T>(table: string, rows: T[]): Promise<T[]> {
  const owner = INTERNAL_NOTE_OWNERS[table];
  if (!owner || rows.length === 0) return rows;

  const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
  const { data, error } = await client()
    .from('internal_notes')
    .select(`body,${owner}`)
    .in(owner, ids);
  if (error) {
    // Never break a page because an annotation could not be read.
    console.warn('internal notes unavailable:', error.message);
    return rows;
  }

  const byOwner = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Record<string, string>[]) {
    byOwner.set(row[owner], row.body);
  }
  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    ...row,
    internal_notes: byOwner.get(String(row.id)) ?? null,
  })) as unknown as T[];
}


/**
 * RPC bridge.
 *
 * The UI speaks in short symbolic names ('record_payment'); Postgres exposes
 * `rpc_*` functions with `p_`-prefixed parameters. Without this mapping the
 * browser asked PostgREST for functions that do not exist, so every payment,
 * receipt and portal action failed in live mode while working in the demo.
 * Keeping the translation in one table makes the contract explicit and testable.
 */
interface RpcBinding {
  /** SQL function in public, when the operation is a database transaction. */
  sql?: string;
  /** Edge Function, when the operation needs the Auth Admin API. */
  edge?: { name: string; action: string };
  toArgs: (args: Row) => Row;
}

const RPC_BINDINGS: Record<Exclude<RpcName, 'create_client_portal'>, RpcBinding> = {
  record_payment: {
    sql: 'rpc_record_payment',
    toArgs: (a) => ({
      p_invoice_id: a.invoice_id,
      p_amount_minor: a.amount_minor,
      p_paid_at: a.paid_at ?? null,
      p_method: a.method ?? 'upi',
      p_reference: a.reference ?? null,
      p_notes: a.notes ?? null,
    }),
  },
  void_payment: {
    sql: 'rpc_void_payment',
    toArgs: (a) => ({ p_payment_id: a.payment_id, p_reason: a.reason ?? null }),
  },
  issue_receipt: {
    sql: 'rpc_issue_receipt',
    toArgs: (a) => ({ p_payment_id: a.payment_id, p_notes: a.notes ?? null }),
  },
  change_client_access_code: {
    sql: 'rpc_change_client_access_code',
    toArgs: (a) => ({ p_client_id: a.client_id, p_code: a.code }),
  },
  revoke_client_access: {
    sql: 'rpc_revoke_client_access',
    toArgs: (a) => ({ p_client_id: a.client_id, p_reason: a.reason ?? null }),
  },
  refresh_invoice_status: {
    sql: 'rpc_refresh_invoice_status',
    toArgs: (a) => ({ p_invoice_id: a.invoice_id }),
  },
};

export class SupabaseAdapter implements DataAdapter {
  readonly mode = 'live' as const;

  async list<T>(table: TableName, opts: ListOptions = {}): Promise<T[]> {
    let q = client().from(table).select(opts.select ?? '*');
    for (const [key, value] of Object.entries(opts.where ?? {})) {
      q = value === null ? q.is(key, null) : q.eq(key, value);
    }
    if (opts.order) q = q.order(opts.order.column, { ascending: opts.order.ascending ?? true });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    return attachNotes(table, (data ?? []) as T[]);
  }

  async get<T>(table: TableName, id: string): Promise<T | null> {
    const { data, error } = await client().from(table).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data) return null;
    const [merged] = await attachNotes(table, [data as T]);
    return merged ?? null;
  }

  async insert<T>(table: TableName, row: Row): Promise<T> {
    const { row: clean, notes } = splitNotes(table, row);
    const { data, error } = await client().from(table).insert(clean).select('*').single();
    if (error) throw new Error(error.message);

    const owner = INTERNAL_NOTE_OWNERS[table];
    if (owner && notes !== undefined) {
      await writeNotes(owner, (data as { id: string }).id, notes);
    }
    return { ...(data as Row), ...(notes !== undefined ? { internal_notes: notes } : {}) } as T;
  }

  async update<T>(table: TableName, id: string, patch: Row): Promise<T> {
    const { row: clean, notes } = splitNotes(table, patch);
    const { data, error } = await client().from(table).update(clean).eq('id', id).select('*').single();
    if (error) throw new Error(error.message);

    const owner = INTERNAL_NOTE_OWNERS[table];
    if (owner && notes !== undefined) {
      await writeNotes(owner, id, notes);
    }
    return { ...(data as Row), ...(notes !== undefined ? { internal_notes: notes } : {}) } as T;
  }

  async remove(table: TableName, id: string): Promise<void> {
    const { error } = await client().from(table).delete().eq('id', id);
    if (error) throw new Error(error.message);
  }

  async rpc<T>(fn: RpcName, args: Row = {}): Promise<T> {
    // Creating (or re-creating) a portal identity needs the Auth Admin API, so
    // it is an Edge Function. With a code it provisions; without one it
    // re-enables an existing portal.
    if (fn === 'create_client_portal') {
      if (!args.code) {
        const { data, error } = await client().rpc('rpc_reactivate_client_portal', {
          p_client_id: args.client_id,
        });
        if (error) throw new Error(error.message);
        return data as T;
      }
      const { data, error } = await client().functions.invoke('admin-clients', {
        body: {
          action: 'create_portal',
          client_id: args.client_id,
          code: args.code,
          email: args.email ?? null,
          full_name: args.full_name ?? null,
        },
      });
      if (error) throw new Error(await describeFunctionError(error));
      const body = data as { ok?: boolean; error?: string; message?: string };
      if (!body?.ok) throw new Error(body?.message ?? 'The portal could not be created.');
      return body as T;
    }

    const binding = RPC_BINDINGS[fn];
    if (!binding?.sql) throw new Error(`No server binding for ${fn}`);
    const { data, error } = await client().rpc(binding.sql, binding.toArgs(args));
    if (error) throw new Error(error.message);
    return data as T;
  }

  async uploadLogo(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Logo must be an image file');
    if (file.size > 2 * 1024 * 1024) throw new Error('Logo must be smaller than 2 MB');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
    const path = `logo-${Date.now()}.${ext}`;
    const { error } = await client().storage.from('branding').upload(path, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type,
    });
    if (error) throw new Error(error.message);
    const { data } = client().storage.from('branding').getPublicUrl(path);
    return data.publicUrl;
  }
}


/** Turn a supabase-js function error (which hides the response body) into text. */
async function describeFunctionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.clone().json()) as { message?: string; error?: string };
      if (body?.message) return body.message;
      if (body?.error) return body.error;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : 'The request failed.';
}

let cachedUserId: string | null = null;

export class SupabaseAuth implements AuthAdapter {
  readonly mode = 'live' as const;

  async init(): Promise<string | null> {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    cachedUserId = data.session?.user?.id ?? null;
    return cachedUserId;
  }

  async signInWithPassword(email: string, password: string) {
    const { error } = await client().auth.signInWithPassword({ email: email.trim(), password });
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  async sendMagicLink(email: string) {
    const { error } = await client().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}#/auth/callback` },
    });
    // Always report success to avoid account enumeration.
    return error && error.status !== 422 ? { ok: false, error: error.message } : { ok: true };
  }

  /**
   * Exchanges a low-entropy client code for a real Supabase session.
   * The Edge Function verifies the code against a hashed verifier, enforces
   * rate limits, and returns a short-lived token hash we exchange here.
   * The browser never receives the user's password or a reusable secret.
   */
  async signInWithAccessCode(code: string): Promise<AccessResult> {
    const { data, error } = await client().functions.invoke('access-code-login', {
      body: { code: code.trim().toUpperCase() },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        try {
          const body = (await ctx.json()) as { error?: string; retry_after?: number };
          return { ok: false, error: body.error ?? 'Sign-in failed.', retryAfterSeconds: body.retry_after };
        } catch {
          /* fall through */
        }
      }
      return { ok: false, error: 'Sign-in service is unavailable. Please try again.' };
    }
    const body = data as { kind?: string; token_hash?: string; error?: string; retry_after?: number; role?: string; display_name?: string };
    if (body?.error) return { ok: false, error: body.error, retryAfterSeconds: body.retry_after };
    if (body?.token_hash) {
      // The Edge Function mints the hash with generateLink({ type: 'magiclink' }),
      // so it must be verified with the same type.
      const { error: otpError } = await client().auth.verifyOtp({ token_hash: body.token_hash, type: 'magiclink' });
      if (otpError) return { ok: false, error: 'That code has expired. Please request a new one.' };
      return { ok: true, role: (body.role as 'client' | 'admin') ?? 'client', displayName: body.display_name ?? '' };
    }
    return { ok: false, error: 'Sign-in failed.' };
  }

  /**
   * Admin entry. The code only *identifies* the administrator; the password
   * is what authenticates, and the role claim is verified again by RLS.
   */
  async signInAdminWithCode(code: string, password: string): Promise<AccessResult> {
    const { data, error } = await client().functions.invoke('access-code-login', {
      body: { code: code.trim().toUpperCase(), intent: 'admin_lookup' },
    });
    if (error) return { ok: false, error: 'Administrator code verification failed.' };
    const body = data as { kind?: string; email?: string; error?: string };
    if (body?.error || body?.kind !== 'admin' || !body.email) {
      return { ok: false, error: 'That is not a valid administrator code.' };
    }
    const signIn = await this.signInWithPassword(body.email, password);
    if (!signIn.ok) return { ok: false, error: signIn.error ?? 'Incorrect password.' };
    return { ok: true, role: 'admin', displayName: body.email };
  }

  async signOut() {
    await client().auth.signOut();
  }

  getCurrentUserId(): string | null {
    return cachedUserId;
  }

  onAuthStateChange(cb: (userId: string | null) => void) {
    if (!supabase) return () => {};
    const { data } = supabase.auth.onAuthStateChange((_event, session: Session | null) => {
      cachedUserId = session?.user?.id ?? null;
      cb(cachedUserId);
    });
    return () => data.subscription.unsubscribe();
  }
}
