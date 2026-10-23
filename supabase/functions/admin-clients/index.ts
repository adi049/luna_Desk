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

      // Reuse an existing auth user with this address, otherwise create one.
      const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      let userId = list?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null;

      if (!userId) {
        const { data: created, error: createError } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: { full_name: fullName, kind: 'client-portal' },
        });
        if (createError || !created?.user) throw createError ?? new Error('createUser failed');
        userId = created.user.id;
      }

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
