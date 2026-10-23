import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// BASE_PATH lets the same build work for GitHub Pages project sites
// (https://user.github.io/repo/) and for root-level hosting (Netlify, Vercel,
// custom domain). Set BASE_PATH=/ for a user/organisation Pages site.
//
// A production build must never ship a live app that cannot reach Supabase: a
// missing URL/anon key used to produce a bundle that booted to an error screen
// on GitHub Pages. Rule:
//   - `vite build` with VITE_DATA_MODE=demo  → allowed (clearly labelled demo)
//   - `vite build` in live mode              → requires URL + anon key
//   - `vite dev`                             → warns, never blocks
// Values copied straight from .env.example. They are non-empty, so a naive
// "is it set?" check passes them — and the deployed site then boots to a
// network error because no such Supabase project exists.
const PLACEHOLDER_PATTERNS = [
  /YOUR[-_]?PROJECT/i,
  /your[-_]?anon/i,
  /your[-_]?supabase/i,
  /example\.com/i,
  /^changeme$/i,
  /^todo$/i,
  /^x+$/i,
];

function looksPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

// A live build must point at a real https endpoint. localhost is allowed so
// that a developer can build against `supabase start`, but nothing else.
function urlProblem(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) return null;
  return 'must use https (http is only accepted for localhost / 127.0.0.1)';
}

function assertDeployableEnv(command: string, env: Record<string, string | undefined>) {
  const dataMode = env.VITE_DATA_MODE === 'demo' ? 'demo' : 'live';
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const key = env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

  if (dataMode === 'demo') {
    console.warn(
      '\n[lunadesk] Building in DEMO mode (VITE_DATA_MODE=demo).\n' +
        '            The bundle contains the labelled demo dataset, not a live app.\n',
    );
    return;
  }

  // Collect every problem before failing, so one build tells you all of them.
  const problems: string[] = [];

  if (!url) problems.push('VITE_SUPABASE_URL is missing');
  else if (looksPlaceholder(url)) problems.push('VITE_SUPABASE_URL still holds the placeholder from .env.example');
  else {
    const problem = urlProblem(url);
    if (problem) problems.push(`VITE_SUPABASE_URL ${problem}`);
  }

  if (!key) problems.push('VITE_SUPABASE_ANON_KEY is missing');
  else if (looksPlaceholder(key)) problems.push('VITE_SUPABASE_ANON_KEY still holds the placeholder from .env.example');
  else if (key.length < 20) problems.push('VITE_SUPABASE_ANON_KEY is too short to be a real publishable key');

  if (problems.length === 0) return;

  const message =
    '[lunadesk] Refusing to build a live bundle:\n' +
    problems.map((problem) => `  - ${problem}`).join('\n') +
    '\n\n' +
    '  Live mode needs real values in the build environment (repository secrets\n' +
    '  for GitHub Pages). Without them the deployed app cannot sign anyone in.\n\n' +
    '  For a demo build instead, set VITE_DATA_MODE=demo.\n';

  if (command === 'build') throw new Error(message);
  console.warn(message);
}

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  assertDeployableEnv(command, env);

  return {
    base: process.env.BASE_PATH ?? '/',
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2020',
      // Sourcemaps help locally and on CI debugging, but a public Pages site
      // does not need to ship readable source, and the maps for the three.js
      // chunk are ~2.6 MB — enough to exhaust a 2 GB build box. CI builds
      // therefore omit them; set SOURCEMAP=true to force them back on.
      sourcemap: process.env.CI || process.env.SOURCEMAP === 'false' ? false : true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            three: ['three', '@react-three/fiber', '@react-three/drei'],
            charts: ['recharts'],
            supabase: ['@supabase/supabase-js'],
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      // Preview hosts are proxied under a generated *.e2b.app domain; allow them
      // in development only. Production builds are served as static files.
      allowedHosts: true,
      cors: true,
    },
    preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  };
});
