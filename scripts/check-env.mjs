#!/usr/bin/env node
/**
 * Build-time environment validation.
 *
 * A static frontend fails in the worst possible way when its configuration is
 * wrong: the page loads, the sign-in form renders, and every request 404s or
 * the key is rejected. That looks like "the app is broken" rather than "one
 * secret is missing". This script turns those failures into a build error with
 * a sentence that says which variable is wrong and why.
 *
 * It checks shape, not reachability: nothing here contacts Supabase, so it is
 * safe to run in CI and locally with no secrets present.
 *
 * Usage:
 *   node scripts/check-env.mjs              # validate the current environment
 *   node scripts/check-env.mjs --allow-demo # permit VITE_DATA_MODE=demo
 *   node scripts/check-env.mjs --self-test  # run the script's own test cases
 */
import process from 'node:process';

const errors = [];
const warnings = [];

function err(message) {
  errors.push(message);
}
function warn(message) {
  warnings.push(message);
}

/** A Supabase JWT is base64url JSON in the middle segment. */
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function validate(env, { allowDemo = false, strict = true } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  const soft = (m) => warnings.push(m);

  const mode = (env.VITE_DATA_MODE ?? '').trim();
  const dataMode = mode === '' ? 'live' : mode;

  // ---- data mode -----------------------------------------------------------
  if (dataMode !== 'live' && dataMode !== 'demo') {
    fail(`VITE_DATA_MODE must be "live" or "demo" (got "${mode}"). Live is the default.`);
  }
  if (dataMode === 'demo') {
    if (allowDemo) {
      soft('VITE_DATA_MODE=demo: this build ships a fictional, clearly-labelled dataset. Never deploy it as production.');
    } else {
      fail('VITE_DATA_MODE=demo is not allowed for a production build. Pass --allow-demo only for a demo deployment.');
    }
  }

  // ---- base path -----------------------------------------------------------
  const basePath = env.BASE_PATH ?? '/';
  if (!basePath.startsWith('/')) fail(`BASE_PATH must start with "/" (got "${basePath}").`);
  if (!basePath.endsWith('/')) fail(`BASE_PATH must end with "/" (got "${basePath}") — a missing slash breaks asset URLs.`);
  if (/\/\//.test(basePath)) fail(`BASE_PATH must not contain "//" (got "${basePath}").`);

  // ---- Supabase URL --------------------------------------------------------
  if (dataMode === 'live') {
    const url = (env.VITE_SUPABASE_URL ?? '').trim();
    if (!url) {
      fail('VITE_SUPABASE_URL is required for a live build (https://<project-ref>.supabase.co).');
    } else {
      let parsed = null;
      try {
        parsed = new URL(url);
      } catch {
        fail(`VITE_SUPABASE_URL is not a valid URL (got "${url}").`);
      }
      if (parsed) {
        if (parsed.protocol !== 'https:') fail(`VITE_SUPABASE_URL must use https (got "${parsed.protocol}").`);
        if (parsed.pathname !== '/' && parsed.pathname !== '') {
          fail(`VITE_SUPABASE_URL must be the project origin with no path (got "${parsed.pathname}").`);
        }
        if (parsed.search || parsed.hash) fail('VITE_SUPABASE_URL must not carry a query string or fragment.');
        const host = parsed.hostname;
        const isSupabase = host.endsWith('.supabase.co') || host.endsWith('.supabase.in');
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
        if (isLocal) {
          if (strict) fail(`VITE_SUPABASE_URL points at ${host}. A deployed build cannot reach it — the browser is not your machine.`);
        } else if (!isSupabase) {
          soft(`VITE_SUPABASE_URL host "${host}" is not a *.supabase.co domain — fine for a self-hosted gateway, otherwise check for a typo.`);
        }
      }
    }

    // ---- Supabase key ------------------------------------------------------
    const key = (env.VITE_SUPABASE_ANON_KEY ?? '').trim();
    if (!key) {
      fail('VITE_SUPABASE_ANON_KEY is required for a live build (the anon / publishable key, never service_role).');
    } else if (/^sb_publishable_/.test(key)) {
      // New-style publishable key: no role claim to inspect.
    } else if (/^sb_secret_/.test(key)) {
      fail('VITE_SUPABASE_ANON_KEY is a secret key (sb_secret_…). Only publishable keys may reach the browser.');
    } else {
      const payload = decodeJwtPayload(key);
      if (!payload) {
        fail('VITE_SUPABASE_ANON_KEY is not a Supabase JWT (expected three dot-separated segments).');
      } else if (payload.role === 'service_role') {
        fail('VITE_SUPABASE_ANON_KEY carries the service_role claim. That key bypasses every RLS policy and must never be in browser code.');
      } else if (payload.role !== 'anon') {
        soft(`VITE_SUPABASE_ANON_KEY has role "${payload.role ?? 'unknown'}"; the anon key is expected.`);
      }
    }
  }

  // ---- optional values -----------------------------------------------------
  const email = (env.VITE_SUPPORT_EMAIL ?? '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(`VITE_SUPPORT_EMAIL does not look like an address (got "${email}").`);
  }

  const vapid = (env.VITE_VAPID_PUBLIC_KEY ?? '').trim();
  if (vapid) {
    // Uncompressed P-256 point: 65 bytes, base64url ≈ 87 chars.
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(vapid)) {
      fail('VITE_VAPID_PUBLIC_KEY is not a base64url public key (expected ~87 characters, no padding).');
    }
  } else {
    soft('VITE_VAPID_PUBLIC_KEY is unset: push notifications stay off and the UI says so truthfully.');
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Self-test. Each case is a tiny environment plus the outcome we expect, so the
// validator cannot rot into a script that always passes.
// ---------------------------------------------------------------------------
const ANON_JWT = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.sig`;
const SERVICE_JWT = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.sig`;

const CASES = [
  ['valid live config', {
    VITE_DATA_MODE: 'live', BASE_PATH: '/lunadesk/',
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: ANON_JWT,
    VITE_SUPPORT_EMAIL: 'hello@lunadesk.in', VITE_VAPID_PUBLIC_KEY: 'B'.repeat(87),
  }, 'ok', {}],
  ['demo without permission', { VITE_DATA_MODE: 'demo' }, 'error', {}],
  ['demo with permission', { VITE_DATA_MODE: 'demo', BASE_PATH: '/' }, 'ok', { allowDemo: true }],
  ['unknown mode', { VITE_DATA_MODE: 'staging' }, 'error', {}],
  ['missing url', { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: ANON_JWT }, 'error', {}],
  ['missing key', { VITE_SUPABASE_URL: 'https://abcd.supabase.co' }, 'error', {}],
  ['service role key', {
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: SERVICE_JWT,
  }, 'error', {}],
  ['secret-style key', {
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_secret_abc123',
  }, 'error', {}],
  ['publishable key accepted', {
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: 'sb_publishable_abc123',
  }, 'ok', {}],
  ['http url', {
    VITE_SUPABASE_URL: 'http://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: ANON_JWT,
  }, 'error', {}],
  ['localhost url in strict mode', {
    VITE_SUPABASE_URL: 'https://localhost', VITE_SUPABASE_ANON_KEY: ANON_JWT,
  }, 'error', {}],
  ['base path without trailing slash', { BASE_PATH: '/lunadesk', VITE_DATA_MODE: 'demo' }, 'error', { allowDemo: true }],
  ['malformed support email', {
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: ANON_JWT,
    VITE_SUPPORT_EMAIL: 'hello@lunadesk',
  }, 'error', {}],
  ['malformed vapid key', {
    VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_ANON_KEY: ANON_JWT,
    VITE_VAPID_PUBLIC_KEY: 'not-a-key',
  }, 'error', {}],
];

function selfTest() {
  let passed = 0;
  const failures = [];
  for (const [name, env, expected, options] of CASES) {
    const { errors: e } = validate(env, options);
    const actual = e.length === 0 ? 'ok' : 'error';
    if (actual === expected) {
      passed += 1;
      console.log(`ok — ${name}`);
    } else {
      failures.push(`${name}: expected ${expected}, got ${actual} (${e.join(' | ')})`);
    }
  }
  for (const f of failures) console.error(`✗ ${f}`);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  return failures.length === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }

  const allowDemo = args.includes('--allow-demo');
  const strict = !args.includes('--allow-local');
  const { errors: e, warnings: w } = validate(process.env, { allowDemo, strict });

  for (const message of w) console.warn(`! ${message}`);
  if (e.length > 0) {
    console.error('\n✗ environment is not deployable:');
    for (const message of e) console.error(`  · ${message}`);
    console.error('\nSee .env.example and docs/SETUP.md for the full list.\n');
    process.exit(1);
  }
  console.log('✓ environment configuration is valid for a build');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
