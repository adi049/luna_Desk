// Server-side Supabase clients.
//
// service_role lives ONLY in these Edge Functions. It is read from the
// function's own environment (Supabase injects SUPABASE_SERVICE_ROLE_KEY), so
// it never reaches the browser bundle.
//
// Two clients, two jobs — and confusing them is a live bug we actually shipped:
//
//   serviceClient()  Auth Admin API only (getUser, createUser, listUsers,
//                    generateLink). These require the service key and have no
//                    end-user identity by design.
//   userClient()     Every SQL RPC. It carries the caller's JWT, so auth.uid()
//                    inside the function is the real user and the RPC's own
//                    authorization still applies.
//
// Historical defect: `admin-clients` authenticated the caller correctly and
// then ran `rpc_attach_client_portal` through the service client. With the
// service key and no user JWT, auth.uid() is NULL, so assert_admin() raised
// 42501 and *every* portal action failed with "Administrator role required" —
// while looking, from the browser, like a permissions problem rather than a
// wiring problem. See docs/AUDIT.md §11.1.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const serviceClient = (): SupabaseClient => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('Supabase service credentials are not configured for this function');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-lunadesk-function': 'service' } },
  });
};

/**
 * A client that acts *as the caller* for SQL RPC calls.
 *
 * Uses the publishable/anon key — never the service key — plus the caller's own
 * Authorization header, which is exactly the context PostgREST would give the
 * browser. That means `auth.uid()` is the signed-in user and every RPC's
 * internal `assert_admin()` / `is_client_of()` check is still enforced in the
 * database. Running the same RPC through the service client would silently
 * discard the identity and either fail closed (assert_admin) or, worse, skip a
 * check that is written in terms of auth.uid().
 */
export const userClient = (accessToken: string): SupabaseClient => {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) {
    throw new Error('Supabase URL / publishable key are not configured for this function');
  }
  if (!accessToken) {
    throw new Error('userClient() requires the caller access token');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-lunadesk-function': 'user',
      },
    },
  });
};

export interface Caller {
  id: string;
  email: string | null;
  isAdmin: boolean;
  /** The caller's raw JWT, for userClient(). Never logged, never returned. */
  token: string;
}

/**
 * Resolve the caller from their JWT and confirm they are an active admin.
 * Returns null when the token is missing or invalid.
 *
 * This is an *identification* step, not the authorization decision: the RPCs
 * re-check with assert_admin(). Both matter — this one gives a clean 403
 * instead of a database error, the database one is the actual boundary.
 */
export async function requireAdmin(req: Request): Promise<Caller | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const supabase = serviceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', data.user.id)
    .maybeSingle();

  // Fail closed, but say why. A failed lookup is not the same as "this user is
  // not an administrator": swallowing it turns an outage into a 403 that looks
  // like a permissions problem and leaves nothing in the logs.
  if (profileError) {
    console.error('admin profile lookup failed', profileError.message);
    return null;
  }

  const isAdmin = profile?.role === 'admin' && profile.is_active !== false;
  if (!isAdmin) return null;

  return { id: data.user.id, email: data.user.email ?? null, isAdmin, token };
}
