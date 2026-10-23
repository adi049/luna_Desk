// =============================================================================
// POST /functions/v1/admin-clients
//
// Admin-only operations that need the Auth Admin API, which is impossible from
// the browser without the service key:
//
//   { action: 'create_portal', client_id, email?, code, full_name? }
//   { action: 'rotate_code',   client_id, code }
//   { action: 'revoke',        client_id, reason? }
//
// Every action re-checks the caller's admin role server-side; the request body
// is never trusted for identity.
// =============================================================================

import { json, preflight } from '../_shared/http.ts';
import { requireAdmin, serviceClient } from '../_shared/supabase.ts';

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
  supabase: ReturnType<typeof serviceClient>,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase();

  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: USERS_PER_PAGE,
    });
    if (error) throw error;

    const users = data?.users ?? [];
    const match = users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match.id;

    // Last page: fewer results than requested means there is nothing after it.
    if (users.length < USERS_PER_PAGE) return null;
  }

  throw new Error(
    `Could not resolve an account for ${email}: more than ${MAX_USER_PAGES * USERS_PER_PAGE} users exist. Attach the portal manually.`,
  );
}

async function ensureAuthUser(
  email: string,
  fullName: string,
  clientId: string,
): Promise<string> {
  const supabase = serviceClient();

  const existing = await findAuthUserByEmail(supabase, email);
  if (existing) return existing;

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName, kind: 'client-portal', client_id: clientId },
  });

  if (!createError && created?.user) return created.user.id;

  // Lost a race with a concurrent creation, or the address already existed
  // under a slightly different case. Re-resolve rather than failing.
  const raced = await findAuthUserByEmail(supabase, email);
  if (raced) return raced;

  throw createError ?? new Error('createUser failed and the account could not be found afterwards');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, origin);

  const caller = await requireAdmin(req);
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

  const supabase = serviceClient();

  const { data: client, error: clientError } = await supabase
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

      const userId = await ensureAuthUser(email, fullName, clientId);

      const { error: rpcError } = await supabase.rpc('rpc_attach_client_portal', {
        p_client_id: clientId,
        p_user_id: userId,
        p_code: code,
        p_label: 'Portal access',
      });
      if (rpcError) throw rpcError;

      return json({ ok: true, user_id: userId, email }, 200, origin);
    }

    if (action === 'rotate_code') {
      const { error } = await supabase.rpc('rpc_change_client_access_code', {
        p_client_id: clientId,
        p_code: code,
      });
      if (error) throw error;
      return json({ ok: true }, 200, origin);
    }

    if (action === 'revoke') {
      const { error } = await supabase.rpc('rpc_revoke_client_access', {
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
});
