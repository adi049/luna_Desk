#!/usr/bin/env node
/**
 * Contract check: the browser's RPC bridge vs the SQL migrations.
 *
 * This exists because the audit found a whole class of bug that no unit test
 * caught: the UI called `record_payment` while Postgres defined
 * `rpc_record_payment(p_invoice_id, …)`. In demo mode everything worked; in
 * live mode every financial action would have 404'd.
 *
 * The script parses the migrations for `create or replace function public.<name>`
 * and the Supabase adapter's binding table, then asserts:
 *
 *   1. every binding points at a function that actually exists;
 *   2. every function the bridge uses takes the `p_*` parameters it is passed;
 *   3. every function the bridge uses is executable by `authenticated`
 *      (or is service-role only on purpose, and then is NOT bridged).
 *
 * Run: node scripts/check-rpc-contract.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const migrationsDir = join(root, 'supabase/migrations');
const adapterPath = join(root, 'src/lib/data/supabase.ts');

const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
  .join('\n');

const adapter = readFileSync(adapterPath, 'utf8');

/* ---------------------------------------------------------------- functions */
/** name → { params: string[] } */
const functions = new Map();

// Linear scan: locate each definition, then read its parameter list up to the
// matching ')'. Far cheaper and more predictable than a nested-quantifier regex.
const defMarker = /create or replace function\s+public\.([a-z0-9_]+)\s*\(/gi;
let def;
while ((def = defMarker.exec(sql)) !== null) {
  const name = def[1];
  let depth = 1;
  let i = defMarker.lastIndex;
  const paramStart = i;
  while (i < sql.length && depth > 0) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    i += 1;
  }
  const rawParams = sql.slice(paramStart, i - 1);
  const params = rawParams
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  functions.set(name, { params });
}

/* ------------------------------------------------------------- grants table */
const granted = new Set();
{
  const grantRe = /grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\([^)]*\)\s+to\s+([^;]+);/gi;
  let m;
  while ((m = grantRe.exec(sql)) !== null) {
    if (/\bauthenticated\b/.test(m[2])) granted.add(m[1]);
  }
}

const serviceOnly = new Set();
{
  const revokeRe = /revoke\s+all\s+on\s+function\s+public\.([a-z0-9_]+)\s*\([^)]*\)\s+from[^;]*authenticated/gi;
  let m;
  while ((m = revokeRe.exec(sql)) !== null) serviceOnly.add(m[1]);
}

/* --------------------------------------------------------------- the bridge */
// Bindings look like:  alias: { sql: 'rpc_x', toArgs: (a) => ({ p_a: …, p_b: … }) },
const bindings = [];
{
  const sqlRefRe = /([a-z_]+):\s*\{\s*sql:\s*'([a-z0-9_]+)'/g;
  // Collect positions first so each binding's args are read only up to the
  // next binding — a fixed-size window silently swallows the neighbour's args.
  const hits = [...adapter.matchAll(sqlRefRe)];
  // The table ends at the first '\n};' after a hit; without that bound the
  // final binding would read the code that follows the table.
  const tableEnd = adapter.indexOf('\n};', hits[0]?.index ?? 0);
  hits.forEach((m, idx) => {
    const end = idx + 1 < hits.length ? hits[idx + 1].index : (tableEnd > 0 ? tableEnd : m.index + 400);
    const window = adapter.slice(m.index, end);
    const args = [...window.matchAll(/(p_[a-z0-9_]+)\s*:/g)].map((x) => x[1]);
    bindings.push({ alias: m[1], sqlName: m[2], args: [...new Set(args)] });
  });
}

// Direct calls made inline in the adapter (the create_client_portal path).
const inline = [];
{
  const inlineRe = /client\(\)\.rpc\('([a-z0-9_]+)',\s*\{/g;
  const hits = [...adapter.matchAll(inlineRe)];
  hits.forEach((m, idx) => {
    const end = idx + 1 < hits.length ? hits[idx + 1].index : adapter.length;
    const window = adapter.slice(m.index, end);
    const args = [...window.matchAll(/(p_[a-z0-9_]+)\s*:/g)].map((x) => x[1]);
    inline.push({ sqlName: m[1], args: [...new Set(args)] });
  });
}

/* ------------------------------------------------------------------ checks */
const failures = [];
const notes = [];

if (bindings.length === 0) {
  failures.push('No RPC bindings found — the parser or the adapter changed shape.');
}

for (const { alias, sqlName, args } of bindings) {
  const fn = functions.get(sqlName);
  if (!fn) {
    failures.push(`Bridge alias '${alias}' → ${sqlName}() does not exist in the migrations.`);
    continue;
  }
  for (const arg of args) {
    if (!fn.params.includes(arg)) {
      failures.push(
        `${sqlName}() is called with ${arg}, but its parameters are (${fn.params.join(', ')}).`,
      );
    }
  }
  if (serviceOnly.has(sqlName) && !granted.has(sqlName)) {
    failures.push(`${sqlName}() is service-role only but the browser bridge calls it.`);
  }
  if (!granted.has(sqlName)) {
    failures.push(`${sqlName}() is not granted to authenticated; the browser call would be denied.`);
  }
}

for (const { sqlName, args } of inline) {
  const fn = functions.get(sqlName);
  if (!fn) {
    failures.push(`Adapter calls ${sqlName}() directly, but it does not exist in the migrations.`);
    continue;
  }
  for (const arg of args) {
    if (!fn.params.includes(arg)) {
      failures.push(`${sqlName}() is called with ${arg}, but its parameters are (${fn.params.join(', ')}).`);
    }
  }
  if (!granted.has(sqlName)) {
    failures.push(`${sqlName}() is not granted to authenticated.`);
  }
}

// Every RPC name in the shared union should be reachable from the adapter.
const unionMatch = /export type RpcName\s*=([\s\S]*?);/.exec(
  readFileSync(join(root, 'src/lib/data/types.ts'), 'utf8'),
);
if (unionMatch) {
  const names = [...unionMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const reachable = new Set([...bindings.map((b) => b.alias), 'create_client_portal']);
  for (const name of names) {
    if (!reachable.has(name)) {
      failures.push(`RpcName '${name}' has no binding in the Supabase adapter.`);
    }
  }
}

/* ------------------------------------------------------------------ report */
console.log(`Parsed ${functions.size} SQL functions, ${bindings.length + inline.length} bridged calls.`);

if (notes.length) {
  for (const note of notes) console.log(`  note: ${note}`);
}

if (failures.length) {
  console.error('\nRPC CONTRACT FAILURES:');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('✓ RPC contract holds: every bridged call maps to an existing, granted function with matching parameters.');
