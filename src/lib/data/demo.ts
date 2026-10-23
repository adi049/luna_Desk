/**
 * DEMO ADAPTER — client-side only.
 *
 * Runs the entire application against an in-browser dataset so the product can
 * be evaluated without a Supabase project. It deliberately mirrors the live
 * adapter's *authorisation* rules (client scoping, column stripping, admin-only
 * RPCs) so that behaviours you see in the demo are the behaviours you get in
 * production. The database remains the real enforcement point in live mode.
 *
 * Never imported when VITE_DATA_MODE=live: `src/lib/data/index.ts` selects the
 * adapter with a static-mode import that is tree-shaken per build target.
 */
import { buildDemoDataset, type DemoDataset } from './seed';
import type { DataAdapter, ListOptions, Row, TableName, RpcName, AccessResult } from './types';
import { uuid, nowIso } from '../utils';

const STORE_KEY = 'lunadesk.demo.db.v3';
const SESSION_KEY = 'lunadesk.demo.session.v3';

const ADMIN_ONLY_RPCS: RpcName[] = [
  'record_payment',
  'void_payment',
  'issue_receipt',
  'change_client_access_code',
  'create_client_portal',
  'revoke_client_access',
];

const CLIENT_SCOPED: TableName[] = [
  'client_services',
  'projects',
  'invoices',
  'payments',
  'receipts',
  'announcements',
];

const OWNER_SCOPED: TableName[] = [
  'tasks',
  'notes',
  'reminders',
  'calendar_events',
  'stopwatch_sessions',
  'notifications',
  'notification_preferences',
  'push_subscriptions',
];

/** Tables where the client portal must only see explicitly shared rows. */
const CLIENT_VISIBLE_ONLY: TableName[] = ['projects', 'calendar_events'];

/**
 * Calendar rows reachable by a client: their own personal events, plus agency
 * events explicitly shared with their client record. Mirrors the RLS policy.
 */

function loadDb(): DemoDataset {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as DemoDataset;
  } catch {
    /* corrupted store — reseed */
  }
  const fresh = buildDemoDataset();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(fresh));
  } catch {
    /* storage disabled (private mode) — in-memory only */
  }
  return fresh;
}

let db: DemoDataset | null = null;
function database(): DemoDataset {
  if (!db) db = loadDb();
  return db;
}
function persist() {
  try {
    if (db) localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* ignore */
  }
}

export function resetDemoDatabase() {
  localStorage.removeItem(STORE_KEY);
  localStorage.removeItem(SESSION_KEY);
  db = null;
}

function currentProfile(): Row | null {
  const id = localStorage.getItem(SESSION_KEY);
  if (!id) return null;
  return database().tables.profiles.find((p) => p.id === id) ?? null;
}

function isAdmin(): boolean {
  return currentProfile()?.role === 'admin';
}

function stripInternal(row: Row): Row {
  const copy = { ...row };
  delete copy.internal_notes;
  delete copy.internal_note;
  return copy;
}

function scopeRows(table: TableName, rows: Row[]): Row[] {
  const me = currentProfile();
  if (!me) return [];
  if (me.role === 'admin') return rows;
  const clientId = me.client_id as string | null;
  if (table === 'clients') return rows.filter((r) => r.id === clientId).map(stripInternal);
  if (table === 'calendar_events') {
    return rows
      .filter((r) => r.owner_id === me.id || (r.client_id === clientId && r.client_visible === true))
      .map(stripInternal);
  }
  if (CLIENT_SCOPED.includes(table)) {
    const visible = rows.filter((r) => r.client_id === clientId);
    return CLIENT_VISIBLE_ONLY.includes(table)
      ? visible.filter((r) => r.client_visible === true).map(stripInternal)
      : visible.map(stripInternal);
  }
  if (table === 'project_updates') {
    const projectIds = new Set(
      database().tables.projects.filter((p) => p.client_id === clientId && p.client_visible).map((p) => p.id),
    );
    return rows.filter((r) => projectIds.has(r.project_id) && r.client_visible === true);
  }
  if (table === 'invoice_items') {
    const ids = new Set(
      database().tables.invoices.filter((i) => i.client_id === clientId).map((i) => i.id),
    );
    return rows.filter((r) => ids.has(r.invoice_id));
  }
  if (table === 'services') return rows;
  if (table === 'branding_settings') return rows;
  if (OWNER_SCOPED.includes(table)) {
    // A couple of tables key on `user_id` rather than the generic `owner_id`.
    const ownerKey =
      table === 'notification_preferences' || table === 'push_subscriptions' ? 'user_id' : 'owner_id';
    return rows.filter((r) => r[ownerKey] === me.id || (table === 'notifications' && r.user_id === me.id));
  }
  if (table === 'profiles') return rows.filter((r) => r.id === me.id);
  if (table === 'client_access_codes') return [];
  if (table === 'audit_logs') return [];
  return [];
}

function matchWhere(row: Row, where?: Row): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    return row[k] === v;
  });
}

function sortRows(rows: Row[], order?: { column: string; ascending?: boolean }) {
  if (!order) return rows;
  const { column, ascending = true } = order;
  return [...rows].sort((a, b) => {
    const av = a[column] as string | number | null;
    const bv = b[column] as string | number | null;
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
  });
}

// ---------------------------------------------------------------------------
// Financial helpers (mirror of the SQL functions used in live mode)
// ---------------------------------------------------------------------------

export function invoicePaidMinor(invoiceId: string): number {
  return database().tables.payments
    .filter((p) => p.invoice_id === invoiceId && !p.voided_at)
    .reduce((a, p) => a + Number(p.amount_minor), 0);
}

/**
 * Mirror of the SQL status guard (migration 0007) and finance.ts#effectiveStatus.
 * Precedence: cancelled > paid > overdue > partially_paid > pending. Keeping one
 * definition on each side prevents the demo from disagreeing with production.
 */
function recomputeInvoiceStatus(invoiceId: string) {
  const inv = database().tables.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'cancelled') return;
  const paid = invoicePaidMinor(invoiceId);
  const total = Number(inv.total_minor);
  const overdue = Boolean(inv.due_date) && String(inv.due_date) < new Date().toISOString().slice(0, 10);
  inv.status = paid >= total ? 'paid' : overdue ? 'overdue' : paid > 0 ? 'partially_paid' : 'pending';
  inv.updated_at = nowIso();
}

function nextSequenceNumber(table: TableName, column: string, prefix: string): string {
  const year = new Date().getFullYear();
  const marker = `${prefix}-${year}-`;
  const rows = database().tables[table] ?? [];
  // Highest existing number + 1. Counting rows would reuse a number after a
  // deletion, which is exactly what document numbering must never do.
  const highest = rows.reduce((max, row) => {
    const value = String(row[column] ?? '');
    if (!value.startsWith(marker)) return max;
    const n = Number(value.slice(marker.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${marker}${String(highest + 1).padStart(4, '0')}`;
}

function appendAudit(action: string, entity: string, entityId: string, before: unknown, after: unknown) {
  const me = currentProfile();
  database().tables.audit_logs.unshift({
    id: uuid(),
    actor_id: me?.id ?? null,
    actor_label: (me?.full_name as string) ?? 'System',
    action,
    entity,
    entity_id: entityId,
    before,
    after,
    created_at: nowIso(),
  });
}

function appendNotification(userId: string, kind: string, title: string, body: string, link: string | null, dedupeKey: string | null) {
  const notifs = database().tables.notifications;
  if (dedupeKey && notifs.some((n) => n.user_id === userId && n.dedupe_key === dedupeKey)) return;
  notifs.unshift({
    id: uuid(),
    user_id: userId,
    kind,
    title,
    body,
    link,
    dedupe_key: dedupeKey,
    read_at: null,
    created_at: nowIso(),
  });
}

// ---------------------------------------------------------------------------

export class DemoAdapter implements DataAdapter {
  readonly mode = 'demo' as const;

  async list<T>(table: TableName, opts: ListOptions = {}): Promise<T[]> {
    const rows = scopeRows(table, database().tables[table] ?? []);
    const filtered = rows.filter((r) => matchWhere(r, opts.where));
    const sorted = sortRows(filtered, opts.order ?? this.defaultOrder(table));
    const limited = opts.limit ? sorted.slice(0, opts.limit) : sorted;
    return JSON.parse(JSON.stringify(limited)) as T[];
  }

  private defaultOrder(table: TableName) {
    const descending = ['payments', 'invoices', 'receipts', 'notifications', 'audit_logs', 'project_updates', 'announcements'];
    if (descending.includes(table)) return { column: 'created_at', ascending: false };
    if (table === 'tasks') return { column: 'due_date', ascending: true };
    if (table === 'clients') return { column: 'name', ascending: true };
    return undefined;
  }

  async get<T>(table: TableName, id: string): Promise<T | null> {
    const rows = await this.list<Row>(table, { where: { id } });
    return (rows[0] as T) ?? null;
  }

  async insert<T>(table: TableName, row: Row): Promise<T> {
    const me = currentProfile();
    if (!me) throw new Error('Not signed in');
    if (table === 'client_access_codes' || table === 'audit_logs') {
      throw new Error('This table is managed by server-side functions only.');
    }
    const record: Row = {
      id: uuid(),
      created_at: nowIso(),
      updated_at: nowIso(),
      ...row,
    };
    if (OWNER_SCOPED.includes(table) && !record.owner_id && table !== 'notification_preferences' && table !== 'notifications') {
      record.owner_id = me.id;
    }
    if (table === 'notifications') record.user_id = record.user_id ?? me.id;
    if (table === 'notification_preferences' || table === 'push_subscriptions') record.user_id = me.id;
    // A client may only create rows that belong to them.
    if (me.role !== 'admin' && record.client_id && record.client_id !== me.client_id && table !== 'notes') {
      throw new Error('Forbidden');
    }
    database().tables[table].push(record);
    persist();
    return JSON.parse(JSON.stringify(record)) as T;
  }

  async update<T>(table: TableName, id: string, patch: Row): Promise<T> {
    const rows = database().tables[table];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('Not found');
    const me = currentProfile();
    if (!me) throw new Error('Not signed in');
    const scoped = scopeRows(table, [rows[idx]]);
    if (!scoped.length) throw new Error('Forbidden: row is outside your scope');
    const before = { ...rows[idx] };
    rows[idx] = { ...rows[idx], ...patch, updated_at: nowIso() };
    persist();
    if (table !== 'notification_preferences') {
      appendAudit(`${table}.updated`, table, id, before, rows[idx]);
      persist();
    }
    return JSON.parse(JSON.stringify(rows[idx])) as T;
  }

  async remove(table: TableName, id: string): Promise<void> {
    const rows = database().tables[table];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const scoped = scopeRows(table, [rows[idx]]);
    if (!scoped.length) throw new Error('Forbidden');
    const [removed] = rows.splice(idx, 1);
    appendAudit(`${table}.deleted`, table, id, removed, null);
    persist();
  }

  async rpc<T>(fn: RpcName, args: Row = {}): Promise<T> {
    if (ADMIN_ONLY_RPCS.includes(fn) && !isAdmin()) {
      throw new Error(`forbidden: ${fn} requires the admin role`);
    }
    const tables = database().tables;

    switch (fn) {
      case 'record_payment': {
        const invoiceId = String(args.invoice_id);
        const invoice = tables.invoices.find((i) => i.id === invoiceId);
        if (!invoice) throw new Error('Invoice not found');
        if (invoice.status === 'cancelled') {
          throw new Error('Cannot record a payment against a cancelled invoice');
        }
        const amount = Number(args.amount_minor);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Payment amount must be greater than zero');
        const paid = invoicePaidMinor(invoiceId);
        if (paid + amount > Number(invoice.total_minor)) {
          throw new Error('Payment exceeds the outstanding balance on this invoice');
        }
        const payment: Row = {
          id: uuid(),
          client_id: invoice.client_id,
          invoice_id: invoiceId,
          amount_minor: amount,
          paid_at: args.paid_at ?? new Date().toISOString().slice(0, 10),
          method: args.method ?? 'upi',
          reference: args.reference ?? null,
          notes: args.notes ?? null,
          voided_at: null,
          void_reason: null,
          created_by: currentProfile()?.id ?? null,
          created_at: nowIso(),
        };
        tables.payments.unshift(payment);
        recomputeInvoiceStatus(invoiceId);
        appendAudit('payment.recorded', 'payments', String(payment.id), null, payment);
        const admin = tables.profiles.find((p) => p.role === 'admin');
        if (admin) {
          appendNotification(
            String(admin.id),
            'payment',
            `Payment recorded — ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount / 100)}`,
            `${invoice.invoice_number}`,
            '/admin/payments',
            `payment:${payment.id}`,
          );
        }
        // Receipt is only issued when a payment exists — never before.
        persist();
        return JSON.parse(JSON.stringify(payment)) as T;
      }

      case 'void_payment': {
        const payment = tables.payments.find((p) => p.id === args.payment_id);
        if (!payment) throw new Error('Payment not found');
        if (payment.voided_at) throw new Error('Payment already voided');
        const before = { ...payment };
        payment.voided_at = nowIso();
        payment.void_reason = args.reason ?? 'Corrected by admin';
        recomputeInvoiceStatus(String(payment.invoice_id));
        // The receipt documenting a voided payment is void too — kept, never
        // deleted. This mirrors rpc_void_payment in SQL.
        const receipt = tables.receipts.find((r) => r.payment_id === payment.id);
        if (receipt && !receipt.voided_at) {
          receipt.voided_at = nowIso();
          receipt.void_reason = payment.void_reason;
        }
        appendAudit('payment.voided', 'payments', String(payment.id), before, payment);
        persist();
        return { payment, receipt_voided: Boolean(receipt) } as T;
      }

      case 'issue_receipt': {
        const payment = tables.payments.find((p) => p.id === args.payment_id);
        if (!payment) throw new Error('A receipt can only be issued for a recorded payment');
        if (payment.voided_at) throw new Error('Cannot issue a receipt for a voided payment');
        const existing = tables.receipts.find((r) => r.payment_id === payment.id);
        if (existing) return existing as T;
        const invoice = tables.invoices.find((i) => i.id === payment.invoice_id)!;
        const client = tables.clients.find((c) => c.id === payment.client_id)!;
        const items = tables.invoice_items.filter((i) => i.invoice_id === invoice.id);
        // Payments are unshifted, so a higher index means "recorded earlier".
        const paymentIndex = tables.payments.indexOf(payment);
        const priorPaid = tables.payments
          .filter((p, index) => p.invoice_id === invoice.id && !p.voided_at && index > paymentIndex)
          .reduce((a, p) => a + Number(p.amount_minor), 0);
        const brand = tables.branding_settings[0];
        const number = nextSequenceNumber('receipts', 'receipt_number', String(brand.receipt_prefix ?? 'MBL-RCP'));
        const receipt: Row = {
          id: uuid(),
          receipt_number: number,
          payment_id: payment.id,
          client_id: payment.client_id,
          invoice_id: payment.invoice_id,
          issued_at: new Date().toISOString().slice(0, 10),
          snapshot: {
            receipt_number: number,
            invoice_number: invoice.invoice_number,
            issue_date: new Date().toISOString().slice(0, 10),
            client_name: client.name,
            client_business: client.business_name,
            client_email: client.email,
            client_phone: client.phone,
            items: items.map((i) => ({ description: i.description, amount_minor: i.amount_minor })),
            billing_period:
              invoice.billing_period_start && invoice.billing_period_end
                ? `${invoice.billing_period_start} → ${invoice.billing_period_end}`
                : null,
            invoice_total_minor: invoice.total_minor,
            previously_paid_minor: priorPaid,
            amount_received_minor: payment.amount_minor,
            balance_minor: Math.max(
              0,
              Number(invoice.total_minor) - priorPaid - Number(payment.amount_minor),
            ),
            method: payment.method,
            reference: payment.reference,
            payment_date: payment.paid_at,
            payment_status: invoice.status,
            notes: payment.notes ?? invoice.notes,
            company: {
              company_name: brand.company_name,
              logo_url: brand.logo_url,
              receipt_footer: brand.receipt_footer,
              contact_email: brand.contact_email,
              contact_phone: brand.contact_phone,
              address: brand.address,
              tax_id: brand.tax_id,
              tax_label: brand.tax_label,
            },
          },
          created_at: nowIso(),
        };
        tables.receipts.unshift(receipt);
        appendAudit('receipt.issued', 'receipts', String(receipt.id), null, receipt);
        persist();
        return JSON.parse(JSON.stringify(receipt)) as T;
      }

      case 'change_client_access_code': {
        const clientId = String(args.client_id);
        const code = String(args.code ?? '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new Error('Code must be 4–12 letters or digits');
        const entry = tables.client_access_codes.find((c) => c.client_id === clientId);
        if (entry) {
          entry.label = args.label ?? entry.label;
          entry.is_revoked = false;
          entry.last_used_at = null;
        } else {
          tables.client_access_codes.push({
            id: uuid(),
            user_id: null,
            client_id: clientId,
            label: args.label ?? 'Portal access',
            is_revoked: false,
            last_used_at: null,
            uses_count: 0,
            created_at: nowIso(),
          });
        }
        const ds = database();
        const existingIdx = ds.codes.findIndex((c) => c.code === code);
        if (existingIdx >= 0 && ds.codes[existingIdx].user_id !== entry?.user_id) {
          throw new Error('That code is already in use');
        }
        const client = tables.clients.find((c) => c.id === clientId);
        if (!client) throw new Error('Client not found');
        client.portal_status = 'active';
        client.updated_at = nowIso();
        const userForClient = tables.profiles.find((p) => p.client_id === clientId);
        if (userForClient) {
          const i = ds.codes.findIndex((c) => c.user_id === userForClient.id);
          if (i >= 0) ds.codes[i].code = code;
          else ds.codes.push({ code, user_id: userForClient.id, role: 'client' });
        }
        appendAudit('client.access_code.changed', 'clients', clientId, null, { code_rotated: true });
        persist();
        return { ok: true, code } as T;
      }

      case 'create_client_portal': {
        const clientId = String(args.client_id);
        const client = tables.clients.find((c) => c.id === clientId);
        if (!client) throw new Error('Client not found');
        let user = tables.profiles.find((p) => p.client_id === clientId);
        if (!user) {
          user = {
            id: uuid(),
            role: 'client',
            full_name: client.contact_person ?? client.name,
            email: client.email,
            phone: client.phone,
            avatar_url: null,
            client_id: clientId,
            theme: 'system',
            timezone: 'Asia/Kolkata',
            is_active: true,
            last_seen_at: null,
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          tables.profiles.push(user);
        }
        const code = String(args.code ?? '').trim().toUpperCase();
        if (code && !/^[A-Z0-9]{4,12}$/.test(code)) throw new Error('Code must be 4–12 letters or digits');
        if (code) {
          const ds = database();
          const i = ds.codes.findIndex((c) => c.user_id === user!.id);
          if (i >= 0) ds.codes[i] = { ...ds.codes[i], code, role: 'client' };
          else ds.codes.push({ code, user_id: user.id, role: 'client' });
        }
        tables.client_access_codes.push({
          id: uuid(),
          user_id: user.id,
          client_id: clientId,
          label: 'Portal access',
          is_revoked: false,
          last_used_at: null,
          uses_count: 0,
          created_at: nowIso(),
        });
        client.portal_status = 'active';
        appendAudit('client.portal.activated', 'clients', clientId, null, { code_created: Boolean(code) });
        persist();
        return { ok: true, user_id: user.id } as T;
      }

      case 'revoke_client_access': {
        const clientId = String(args.client_id);
        const client = tables.clients.find((c) => c.id === clientId);
        if (!client) throw new Error('Client not found');
        client.portal_status = 'revoked';
        client.updated_at = nowIso();
        const user = tables.profiles.find((p) => p.client_id === clientId);
        if (user) {
          user.is_active = false;
          user.updated_at = nowIso();
        }
        for (const c of tables.client_access_codes.filter((c) => c.client_id === clientId)) c.is_revoked = true;
        appendAudit('client.access.revoked', 'clients', clientId, { portal_status: 'active' }, { portal_status: 'revoked' });
        persist();
        return { ok: true } as T;
      }

      case 'refresh_invoice_status': {
        const ids = args.invoice_id ? [String(args.invoice_id)] : tables.invoices.map((i) => String(i.id));
        ids.forEach(recomputeInvoiceStatus);
        persist();
        return { ok: true, updated: ids.length } as T;
      }

      default:
        throw new Error(`Unknown function: ${fn}`);
    }
  }

  async uploadLogo(file: File): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Logo must be an image file');
    if (file.size > 2 * 1024 * 1024) throw new Error('Logo must be smaller than 2 MB');
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.readAsDataURL(file);
    });
  }
}

// ---------------------------------------------------------------------------
// Demo authentication
// ---------------------------------------------------------------------------

const attempts = { count: 0, lockedUntil: 0 };

type AuthListener = (userId: string | null) => void;
const authListeners = new Set<AuthListener>();

export class DemoAuth {
  readonly mode = 'demo' as const;

  private profiles(): Row[] {
    return database().tables.profiles;
  }

  private session(id: string | null) {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
    authListeners.forEach((cb) => cb(id));
  }

  async signInWithPassword(email: string, password: string) {
    const ds = database();
    const user = ds.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || user.profile.role !== 'admin') {
      return { ok: false, error: 'No admin account matches those details.' };
    }
    if (user.password !== password) return { ok: false, error: 'Incorrect password.' };
    this.session(user.id);
    return { ok: true };
  }

  async sendMagicLink(email: string) {
    const ds = database();
    const user = ds.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || user.profile.role !== 'admin') {
      // Do not reveal whether the address exists.
      return { ok: true };
    }
    // Demo mode cannot send email; sign the admin in directly and say so in the UI.
    this.session(user.id);
    return { ok: true, error: 'demo-auto-session' };
  }

  async signInWithAccessCode(code: string): Promise<AccessResult> {
    if (Date.now() < attempts.lockedUntil) {
      return {
        ok: false,
        error: `Too many attempts. Try again in ${Math.ceil((attempts.lockedUntil - Date.now()) / 1000)}s.`,
        retryAfterSeconds: Math.ceil((attempts.lockedUntil - Date.now()) / 1000),
      };
    }
    const normalised = code.trim().toUpperCase();
    const ds = database();
    const entry = ds.codes.find((c) => c.code === normalised);
    const profile = entry ? this.profiles().find((p) => p.id === entry.user_id) : undefined;

    if (normalised === 'ADI000') {
      return { ok: false, error: 'Admin access requires the administrator password. Use the admin entry below.' };
    }
    if (!entry || !profile || !profile.is_active) {
      attempts.count += 1;
      if (attempts.count >= 5) {
        attempts.lockedUntil = Date.now() + 30_000;
        attempts.count = 0;
      }
      return { ok: false, error: 'That access code is not recognised.' };
    }
    const client = database().tables.clients.find((c) => c.id === profile.client_id);
    if (!client || client.portal_status !== 'active' || client.status === 'inactive') {
      return { ok: false, error: 'Portal access for this account is currently revoked. Please contact Managed by Luna.' };
    }
    const accessRow = database().tables.client_access_codes.find((c) => c.client_id === profile.client_id);
    if (accessRow?.is_revoked) {
      return { ok: false, error: 'Portal access for this account is currently revoked. Please contact Managed by Luna.' };
    }
    if (accessRow) {
      accessRow.last_used_at = nowIso();
      accessRow.uses_count = Number(accessRow.uses_count ?? 0) + 1;
      persist();
    }
    attempts.count = 0;
    this.session(String(profile.id));
    return { ok: true, role: 'client', displayName: String(profile.full_name) };
  }

  async signInAdminWithCode(code: string, password: string): Promise<AccessResult> {
    const normalised = code.trim().toUpperCase();
    if (normalised !== 'ADI000') return { ok: false, error: 'That is not an administrator code.' };
    const ds = database();
    const user = ds.users.find((u) => u.profile.role === 'admin');
    if (!user) return { ok: false, error: 'No administrator account is provisioned.' };
    if (user.password !== password) return { ok: false, error: 'Incorrect administrator password.' };
    this.session(user.id);
    return { ok: true, role: 'admin', displayName: String(user.profile.full_name) };
  }

  async signOut() {
    this.session(null);
  }

  async init(): Promise<string | null> {
    return this.getCurrentUserId();
  }

  getCurrentUserId(): string | null {
    return localStorage.getItem(SESSION_KEY);
  }

  onAuthStateChange(cb: (userId: string | null) => void) {
    authListeners.add(cb);
    const handler = (e: StorageEvent) => {
      if (e.key === SESSION_KEY) cb(e.newValue);
    };
    window.addEventListener('storage', handler);
    return () => {
      authListeners.delete(cb);
      window.removeEventListener('storage', handler);
    };
  }
}
