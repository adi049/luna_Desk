// Shared HTTP helpers for LunaDesk Edge Functions.
// CORS is intentionally narrow: the function only ever needs to answer the app
// origin(s) configured in APP_ORIGINS (comma separated).

export const corsHeaders = (origin: string | null): Record<string, string> => {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const allow = origin && (allowed.length === 0 || allowed.includes(origin))
    ? origin
    : allowed[0] ?? 'null';

  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
};

export const json = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });

export const preflight = (origin: string | null) =>
  new Response('ok', { headers: corsHeaders(origin) });

/** Best-effort client IP from the proxy headers Supabase sets. */
export const clientIp = (req: Request): string | null => {
  const header = req.headers.get('x-forwarded-for') ?? req.headers.get('cf-connecting-ip');
  const ip = header?.split(',')[0]?.trim();
  return ip && ip.length > 0 ? ip : null;
};

export const rateLimitResponse = (origin: string | null) =>
  json(
    {
      ok: false,
      error: 'rate_limited',
      message: 'Too many attempts. Please wait a few minutes and try again.',
    },
    429,
    origin,
  );
