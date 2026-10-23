// Server-side Supabase clients.
//
// service_role lives ONLY in these Edge Functions. It is read from the
// function's own environment (Supabase injects SUPABASE_SERVICE_ROLE_KEY), so
// it never reaches the browser bundle.

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

export interface Caller {
  id: string;
  email: string | null;
  isAdmin: boolean;
}

/**
 * Resolve the caller from their JWT and confirm they are an active admin.
 * Returns null when the token is missing or invalid.
 */
export async function requireAdmin(req: Request): Promise<Caller | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const supabase = serviceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', data.user.id)
    .maybeSingle();

  const isAdmin = profile?.role === 'admin' && profile.is_active !== false;
  if (!isAdmin) return null;

  return { id: data.user.id, email: data.user.email ?? null, isAdmin };
}
