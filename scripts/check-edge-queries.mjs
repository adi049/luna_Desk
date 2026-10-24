#!/usr/bin/env node
/**
 * Static check: every Supabase query in the Edge Functions must bind and use
 * its `error`.
 *
 * Why a source check rather than a unit test: the functions run on Deno against
 * a live project, so they cannot be executed here (see docs/AUDIT.md §11.7).
 * The defect this guards against is not subtle — a dropped `error` turns a
 * failed read into an empty result, and an empty result is indistinguishable
 * from "nothing to do". In send-reminders that meant: a failed push-subscription
 * lookup reported the reminder as *delivered*.
 *
 * The rule enforced:
 *   every `const { … } = await <something>.from(…)` chain must bind `error`
 *   (directly or renamed) and must mention that name again afterwards.
 *
 * Usage:
 *   node scripts/check-edge-queries.mjs            # check supabase/functions
 *   node scripts/check-edge-queries.mjs --self-test
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
const FUNCTIONS_DIR = join(ROOT, 'supabase/functions');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Finds `.from(` chains that are assigned from a destructuring pattern and
 * reports those whose pattern has no `error` binding, or whose binding is
 * never mentioned again.
 */
export function checkSource(source, label = 'source') {
  const problems = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    // `const { data … } = await …` possibly split over lines.
    const start = line.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+(.*)$/);
    if (!start) return;

    // The chain may continue on following lines; collect enough to see `.from(`.
    const window = [start[2], ...lines.slice(index + 1, index + 6)].join('\n');
    if (!/\.from\s*\(/.test(window)) return;

    const bindings = start[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const renamed = part.match(/^(\w+)\s*:\s*(\w+)$/);
        return renamed ? { source: renamed[1], local: renamed[2] } : { source: part, local: part };
      });

    const errorBinding = bindings.find((b) => b.source === 'error');
    if (!errorBinding) {
      problems.push(
        `${label}:${index + 1}: query result drops \`error\` — a failed read looks like an empty result`,
      );
      return;
    }

    // The binding must actually be consulted, not just named `_error`.
    const name = errorBinding.local;
    if (name.startsWith('_')) return;
    const after = lines.slice(index, index + 25).join('\n');
    const uses = new RegExp(`(^|[^\\w.])${name}\\b`).test(
      after.replace(
        new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\}\\s*=\\s*await[^;]*;`, 'g'),
        '',
      ),
    );
    if (!uses) {
      problems.push(`${label}:${index + 1}: \`${name}\` is bound but never checked`);
    }
  });

  return problems;
}

export function checkTree(dir = FUNCTIONS_DIR) {
  const problems = [];
  for (const file of walk(dir)) {
    const label = relative(ROOT, file);
    problems.push(...checkSource(readFileSync(file, 'utf8'), label));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Self-test: the checker must flag the exact shape of the defect that shipped.
// ---------------------------------------------------------------------------
const CASES = [
  ['the shipped defect', `
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id');
  `, 1],
  ['error bound and checked', `
    const { data, error } = await supabase
      .from('t')
      .select('id');
    if (error) throw error;
  `, 0],
  ['error bound and renamed', `
    const { data, error: queryError } = await supabase.from('t').select('id');
    if (queryError) console.error(queryError.message);
  `, 0],
  ['error bound but ignored', `
    const { data, error } = await supabase.from('t').select('id');
    console.log(data);
  `, 1],
  ['deliberately ignored with _error', `
    const { data, error: _error } = await supabase.from('t').select('id');
    console.log(data);
  `, 0],
  ['not a query', `
    const { a, b } = someFunction();
    console.log(a, b);
  `, 0],
  ['query through a variable chain', `
    const { data, error } = await client
      .from('t')
      .insert(row);
    if (error) return error;
  `, 0],
  ['second query on the same line numbers', `
    const { count } = await supabase.from('t').select('*', { count: 'exact' });
    const { error } = await supabase.from('t').delete();
    console.log(error);
  `, 1],
];

function selfTest() {
  let passed = 0;
  const failures = [];
  for (const [name, source, expected] of CASES) {
    const found = checkSource(source, 'case').length;
    if (found === expected) {
      passed += 1;
      console.log(`ok — ${name}`);
    } else {
      failures.push(`${name}: expected ${expected} problem(s), found ${found}`);
    }
  }
  for (const f of failures) console.error(`✗ ${f}`);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  return failures.length === 0;
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  const problems = checkTree();
  if (problems.length > 0) {
    console.error('✗ unchecked Supabase query results:');
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exit(1);
  }
  console.log('✓ every Edge Function query binds and checks its error');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
