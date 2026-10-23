// Shared HTTP helpers for LunaDesk Edge Functions.
// CORS is intentionally narrow: the function only ever needs to answer the app
// origin(s) configured in APP_ORIGINS (comma separated).

/**
 * CORS.
 *
 * Previously an unset APP_ORIGINS meant "reflect any origin", which is the
 * opposite of a safe default for an endpoint that accepts an access code. Now
 * an unset list allows nothing cross-origin: the login page is same-origin with
 * the function (both are GitHub Pages → Supabase), and browsers do not require
 * CORS for a simple same-site POST *unless* it is cross-origin — which it is in
 * production, so APP_ORIGINS must be set explicitly.
 */
export const corsHeaders = (origin: string | null): Record<string, string> => {
  const allowed = (Deno.env.get('APP_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const normalisedOrigin = origin?.replace(/\/$/, '') ?? null;
  const allow =
    normalisedOrigin && allowed.includes(normalisedOrigin) ? normalisedOrigin : 'null';

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

/**
 * Best-effort client IP for rate limiting.
 *
 * `cf-connecting-ip` is set by the edge network and cannot be spoofed by the
 * caller. `x-forwarded-for` is a comma-separated chain; the *last* entry is the
 * one appended by the nearest proxy, whereas the first can be supplied by the
 * client. We therefore prefer the former and take the tail of the latter.
 *
 * This is one input to the limiter, never the only one: the SQL layer also
 * counts attempts per code prefix, so spoofing an IP does not grant unlimited
 * guesses against a specific code.
 */
export const clientIp = (req: Request): string | null => {
  const direct = req.headers.get('cf-connecting-ip')?.trim();
  if (direct) return direct;

  const chain = req.headers.get('x-forwarded-for');
  const last = chain?.split(',').map((p) => p.trim()).filter(Boolean).pop();
  return last && last.length > 0 ? last : null;
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
