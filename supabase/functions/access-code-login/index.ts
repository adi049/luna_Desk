// =============================================================================
// POST /functions/v1/access-code-login
//
// The only unauthenticated endpoint in LunaDesk. Two modes:
//
// 1. Client portal
//      body: { code: "PR103" }
//      200 : { kind: 'client', token_hash, role: 'client', display_name, business_name }
//
//    The code is verified inside Postgres (bcrypt compare in
//    rpc_redeem_access_code), which also rate-limits by IP and code prefix and
//    writes every attempt to access_attempts. On success we mint a single-use
//    magic-link token hash that the browser exchanges with verifyOtp(). The
//    access code itself never becomes the session, and no password exists for
//    the client account.
//
// 2. Admin lookup
//      body: { code: "ADI000", intent: "admin_lookup" }
//      200 : { kind: 'admin', email }
//
//    This resolves *which* staff account the code belongs to. It does NOT sign
//    anybody in: the browser must still complete signInWithPassword (or the
//    magic-link/MFA flow). A stolen code alone grants nothing.
// =============================================================================

import { clientIp, json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/supabase.ts';

const CODE_PATTERN = /^[A-Z0-9]{5,20}$/;

const MESSAGES: Record<string, { status: number; message: string }> = {
  invalid_code: {
    status: 401,
    message: 'That access code is not recognised. Check the code and try again.',
  },
  access_disabled: {
    status: 403,
    message: 'Portal access for this account is switched off. Please contact Managed by Luna.',
  },
  rate_limited: {
    status: 429,
    message: 'Too many attempts. Please wait a few minutes before trying again.',
  },
};

const fail = (error: string, origin: string | null) => {
  const known = MESSAGES[error] ?? MESSAGES.invalid_code;
  return json(
    { kind: 'error', error: known.message, code: error, retry_after: known.status === 429 ? 600 : undefined },
    known.status,
    origin,
  );
};

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);
  if (req.method !== 'POST') return json({ kind: 'error', error: 'Method not allowed' }, 405, origin);

  let body: { code?: string; intent?: string };
  try {
    body = await req.json();
  } catch {
    return json({ kind: 'error', error: 'Send { code }.' }, 400, origin);
  }

  const code = String(body?.code ?? '').toUpperCase().replace(/\s+/g, '');
  const ip = clientIp(req);
  const ua = req.headers.get('user-agent')?.slice(0, 400) ?? null;

  // Same answer for a malformed code as for an unknown one: no format oracle.
  if (!CODE_PATTERN.test(code)) return fail('invalid_code', origin);

  const supabase = serviceClient();

  // ---------------------------------------------------------------- admin
  if (body?.intent === 'admin_lookup') {
    const { data, error } = await supabase.rpc('rpc_lookup_admin_code', {
      p_code: code,
      p_ip: ip,
      p_user_agent: ua,
    });
    if (error) {
      console.error('admin lookup failed', error.message);
      return json({ kind: 'error', error: 'Verification is unavailable. Try again.' }, 500, origin);
    }
    if (!data?.ok) return fail(String(data?.error ?? 'invalid_code'), origin);
    return json({ kind: 'admin', email: data.email, label: data.label }, 200, origin);
  }

  // --------------------------------------------------------------- client
  const { data, error } = await supabase.rpc('rpc_redeem_access_code', {
    p_code: code,
    p_ip: ip,
    p_user_agent: ua,
  });

  if (error) {
    console.error('redeem failed', error.message);
    return json({ kind: 'error', error: 'Could not verify the code. Please try again.' }, 500, origin);
  }
  if (!data?.ok) return fail(String(data?.error ?? 'invalid_code'), origin);

  const userId = data.user_id as string | null;
  if (!userId) {
    return fail('access_disabled', origin);
  }

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (userError || !email) {
    console.error('portal user lookup failed', userError?.message);
    return fail('access_disabled', origin);
  }

  const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    console.error('link generation failed', linkError?.message);
    return json({ kind: 'error', error: 'Could not start a session. Please try again.' }, 500, origin);
  }

  return json(
    {
      kind: 'client',
      token_hash: link.properties.hashed_token,
      role: 'client',
      display_name: (userData?.user?.user_metadata?.full_name as string | undefined) ?? '',
      business_name: data.business_name,
      client_code: data.client_code,
    },
    200,
    origin,
  );
});
