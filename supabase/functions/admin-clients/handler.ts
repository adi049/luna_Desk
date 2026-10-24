// =============================================================================
// The admin-clients request handler, with its collaborators injected.
//
// This module deliberately imports nothing that reaches Supabase: it takes the
// clients it uses as arguments. That is what lets
// supabase/functions/tests/admin-clients.test.ts execute the real handler in
// Deno with fakes — the failed-provisioning cleanup path decides whether an
// account is deleted, which is not something to verify by reading.
//
// index.ts is the thin wiring: real clients, real Deno.serve().
// =============================================================================

import { json, preflight } from '../_shared/http.ts';

/** The subset of the caller record this handler needs. */
export interface Caller {
  id: string;
  email: string | null;
  isAdmin: boolean;
  token: string;
}

export interface AdminClientsDeps {
  requireAdmin: (req: Request) => Promise<Caller | null>;
  serviceClient: () => any;
  userClient: (token: string) => any;
}

const CODE_PATTERN = /^[A-Z0-9]{5,20}$/;

/** Portal identities do not need a real mailbox, so synthesise a stable one. */
const portalEmail = (clientCode: string, given?: string) => {
  if (given && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(given)) return given.toLowerCase();
  return `portal.${clientCode.toLowerCase()}@clients.managedbyluna.com`;
};

/**
 * Find the auth user for a portal email, creating it only if it truly does not
 * exist.
 *
 * The previous version called listUsers({ page: 1, perPage: 200 }) and searched
 * that single page. With more than 200 users the lookup silently missed
 * existing accounts, so every portal creation for an older client tried to
 * create the address again and failed with "user already registered" — and the
 * failure looked like a transient error rather than a lookup gap.
 *
 * Two changes fix that properly:
 *
 *  1. `getUserByEmail` would be the obvious call, but it is not part of the
 *     supabase-js admin surface in every version, so the fallback walks the
 *     pages. Listing is bounded (MAX_USER_PAGES) so a runaway tenant cannot
 *     make this endpoint unbounded.
 *  2. Creation is treated as a race. Two admins creating the same portal at
 *     once both miss the lookup, and one of them loses. That loser re-runs the
 *     lookup instead of surfacing an error, which is the correct outcome:
 *     the account exists, so the portal can be attached.
 */
const MAX_USER_PAGES = 50;          // 50 × 200 = 10 000 accounts
const USERS_PER_PAGE = 200;

async function findAuthUserByEmail(
  supabase: any,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase();

  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    });
    if (error) throw error;

    const users: Array<{ id: string; email?: string | null }> = data?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;

    // Last page: fewer results than requested means there is nothing after it.
    if (users.length < USERS_PER_PAGE) return null;
  }

  throw new Error(
    `Could not resolve an account for ${email}: more than ${MAX_USER_PAGES * USERS_PER_PAGE} users exist. Attach the portal manually.`,
  );
}

/**
 * The result of resolving a portal account.
 *
 * `created` is the difference between "this request made this account a moment
 * ago, and may delete it again if provisioning fails" and "this account was
 * already here, and must never be touched".
 */
interface EnsuredUser {
  id: string;
  /** True only when *this* request created the account. */
  created: boolean;
}

async function ensureAuthUser(
  supabase: any,
  email: string,
  fullName: string,
  clientId: string,
): Promise<EnsuredUser> {
  const existing = await findAuthUserByEmail(supabase, email);
  if (existing) return { id: existing, created: false };

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName, kind: 'client-portal', client_id: clientId },
  });

  if (!createError && created?.user) return { id: created.user.id, created: true };

  // Lost a race with a concurrent creation, or the address already existed
  // under a slightly different case. Re-resolve rather than failing.
  const raced = await findAuthUserByEmail(supabase, email);
  if (raced) return { id: raced, created: false };

  throw createError ?? new Error('createUser failed and the account could not be found afterwards');
}

/**
 * Undo a half-finished portal provisioning.
 *
 * The only account this may delete is one this request created a few lines ago:
 * if ensureAuthUser() found an existing account (or lost a creation race and
 * adopted the winner's account), a provisioning failure must leave it alone —
 * it may be a live portal identity, or an administrator's mailbox.
 *
 * Nothing here logs the access code, the token, or an email address. The
 * recovery reference is the auth user id, which is what an operator needs to
 * find the row, and which is already visible to the admin who made the call.
 */
async function discardCreatedUser(
  supabase: any,
  userId: string,
  clientId: string,
): Promise<boolean> {
  const { error } = await supabase.auth.admin.deleteUser(userId);

  if (error) {
    console.error(
      'portal provisioning cleanup failed — manual recovery needed',
      JSON.stringify({
        reference: `portal-cleanup:${userId}`,
        user_id: userId,
        client_id: clientId,
        reason: error.message,
      }),
    );
    return false;
  }

  console.warn(
    'portal provisioning rolled back',
    JSON.stringify({ user_id: userId, client_id: clientId }),
  );
  return true;
}

export function makeHandler(deps: AdminClientsDeps) {
  const { requireAdmin: getCaller, serviceClient: getService, userClient: getUser } = deps;

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return preflight(origin);
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

    const caller = await getCaller(req);
    if (!caller) return json({ ok: false, error: 'forbidden' }, 403, origin);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: 'bad_request' }, 400, origin);
    }

    const action = String(body.action ?? '');
    const clientId = String(body.client_id ?? '');
    const code = String(body.code ?? '').toUpperCase().replace(/\s+/g, '');

    if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
      return json({ ok: false, error: 'bad_request', message: 'client_id is required' }, 400, origin);
    }
    if (action !== 'revoke' && !CODE_PATTERN.test(code)) {
      return json(
        { ok: false, error: 'bad_code_format', message: 'Access codes are 5–20 letters or digits.' },
        400,
        origin,
      );
    }

    // Read-only lookup: RLS would let an admin see this anyway, but the service
    // client keeps the 404 path clean for a client id the caller cannot see.
    const service = getService();

    const { data: client, error: clientError } = await service
      .from('clients')
      .select('id, client_code, business_name, email, portal_status')
      .eq('id', clientId)
      .maybeSingle();

    if (clientError || !client) {
      return json({ ok: false, error: 'not_found', message: 'Client not found' }, 404, origin);
    }

    try {
      if (action === 'create_portal') {
        const email = portalEmail(client.client_code, String(body.email ?? client.email ?? ''));
        const fullName = String(body.full_name ?? `${client.business_name} portal`).slice(0, 120);

        const user = await ensureAuthUser(service, email, fullName, clientId);

        // The RPC checks assert_admin() via auth.uid(), so it MUST run with the
        // caller's JWT. Only the Auth Admin calls above need the service client.
        const { error: rpcError } = await getUser(caller.token).rpc('rpc_attach_client_portal', {
          p_client_id: clientId,
          p_user_id: user.id,
          p_code: code,
          p_label: 'Portal access',
        });

        if (rpcError) {
          // A fresh auth user with no portal attached is an orphan: it cannot
          // sign in (no access code works for it) but it does occupy the email
          // address, so the next attempt would find it and skip creation. Remove
          // it — but only if this request is the one that created it.
          let orphanRemoved = false;
          let recoveryReference: string | null = null;

          if (user.created) {
            orphanRemoved = await discardCreatedUser(service, user.id, clientId);
            if (!orphanRemoved) recoveryReference = `portal-cleanup:${user.id}`;
          }

          console.error(
            'portal provisioning failed',
            JSON.stringify({
              client_id: clientId,
              user_id: user.id,
              user_created_here: user.created,
              orphan_removed: orphanRemoved,
              error: rpcError.message,
            }),
          );

          return json(
            {
              ok: false,
              error: 'provisioning_failed',
              // Safe to return: an admin-only endpoint, and no secret is included.
              message: user.created
                ? orphanRemoved
                  ? 'The portal could not be provisioned. The account created for it was removed, so you can retry.'
                  : 'The portal could not be provisioned, and the new account could not be removed automatically.'
                : 'The portal could not be provisioned. The existing account was left untouched.',
              user_id: user.id,
              user_created_here: user.created,
              orphan_removed: orphanRemoved,
              recovery_reference: recoveryReference,
            },
            500,
            origin,
          );
        }

        return json({ ok: true, user_id: user.id, email }, 200, origin);
      }

      if (action === 'rotate_code') {
        const { error } = await getUser(caller.token).rpc('rpc_change_client_access_code', {
          p_client_id: clientId,
          p_code: code,
        });
        if (error) throw error;
        return json({ ok: true }, 200, origin);
      }

      if (action === 'revoke') {
        const { error } = await getUser(caller.token).rpc('rpc_revoke_client_access', {
          p_client_id: clientId,
          p_reason: String(body.reason ?? 'Revoked by ' + (caller.email ?? 'admin')).slice(0, 400),
        });
        if (error) throw error;
        return json({ ok: true }, 200, origin);
      }

      return json({ ok: false, error: 'unknown_action' }, 400, origin);
    } catch (err) {
      console.error('admin-clients failed', err);
      return json(
        { ok: false, error: 'server_error', message: err instanceof Error ? err.message : 'Failed' },
        500,
        origin,
      );
    }
  };
}

