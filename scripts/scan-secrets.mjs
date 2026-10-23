#!/usr/bin/env node
/**
 * Secret scan of tracked files.
 *
 * Run before recommending a public push:
 *   node scripts/scan-secrets.mjs            # working tree
 *   node scripts/scan-secrets.mjs --history  # every blob in git history
 *
 * It looks for the credential shapes that would actually matter here:
 * Supabase/NPM/Stripe-style keys, JWTs, private keys, and assignments that look
 * like a real value rather than a placeholder. It never prints the secret
 * itself — only the file, line and a redacted hint.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const history = process.argv.includes('--history');

/** True when the working directory is inside a git repository. */
function inGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fallback file listing for an extracted archive (the ZIP ships no .git). */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full.replace(/^\.\//, ''));
  }
  return acc;
}

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.woff', '.woff2', '.ttf', '.map', '.lock',
]);
const SKIP_PATH = /(^|\/)(node_modules|dist|\.git|coverage|\.shots|\.final)\//;

const PATTERNS = [
  { name: 'Supabase service_role key', re: /service[_-]?role[^\n]{0,40}?eyJ[A-Za-z0-9_-]{20,}/i },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Stripe secret key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: 'Assigned credential with a real-looking value',
    re: /\b(SUPABASE_SERVICE_ROLE_KEY|VAPID_PRIVATE_KEY|CRON_SECRET|DB_PASSWORD|API_SECRET)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{16,}/,
  },
];

const PLACEHOLDER =
  /(your[-_ ]|example|placeholder|dummy|xxxx|changeme|replace[-_ ]?me|<[^>]+>|\.\.\.|super-secret|test)/i;

const findings = [];

function scanText(label, text) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (PLACEHOLDER.test(line)) return;
    for (const { name, re } of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const value = m[0];
      const redacted = value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '***';
      findings.push({ label, line: index + 1, name, redacted });
      break;
    }
  });
}

const useGit = inGitRepo();

if (history && !useGit) {
  console.error('--history needs a git repository; the extracted archive has no history to scan.');
  process.exit(1);
}

if (history) {
  // Every blob ever committed, so a secret removed in a later commit is caught.
  const files = execSync('git rev-list --objects --all', { encoding: 'utf8' })
    .split('\n')
    .map((row) => row.trim().split(' '))
    .filter((parts) => parts.length === 2 && parts[1]);

  for (const [sha, path] of files) {
    if (SKIP_PATH.test(path) || SKIP_EXT.has(extname(path))) continue;
    let text;
    try {
      text = execSync(`git cat-file -p ${sha}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      continue;
    }
    scanText(`history:${path}`, text);
  }
} else {
  const files = useGit
    ? execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
    : walk('.');
  for (const path of files) {
    if (SKIP_PATH.test(path) || SKIP_EXT.has(extname(path))) continue;
    try {
      if (statSync(path).size > 2 * 1024 * 1024) continue;
      scanText(path, readFileSync(path, 'utf8'));
    } catch {
      /* unreadable (binary, permission) — nothing to scan */
    }
  }
}

if (findings.length) {
  console.error(`Potential secrets found (${findings.length}):`);
  for (const f of findings) console.error(`  ✗ ${f.label}:${f.line} — ${f.name} (${f.redacted})`);
  console.error('\nRemove the value, rotate the credential, then re-run this scan.');
  process.exit(1);
}

console.log(
  history
    ? '✓ No credential-shaped strings in any committed blob.'
    : useGit
      ? '✓ No credential-shaped strings in tracked files.'
      : '✓ No credential-shaped strings in the working tree (no git repo found; scanned files directly).',
);
