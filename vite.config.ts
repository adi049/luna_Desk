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
function assertDeployableEnv(command: string, env: Record<string, string | undefined>) {
  const dataMode = env.VITE_DATA_MODE === 'demo' ? 'demo' : 'live';
  const hasUrl = Boolean(env.VITE_SUPABASE_URL?.trim());
  const hasKey = Boolean(env.VITE_SUPABASE_ANON_KEY?.trim());

  if (dataMode === 'demo') {
    console.warn(
      '\n[lunadesk] Building in DEMO mode (VITE_DATA_MODE=demo).\n' +
        '            The bundle contains the labelled demo dataset, not a live app.\n',
    );
    return;
  }

  const missing = [
    hasUrl ? null : 'VITE_SUPABASE_URL',
    hasKey ? null : 'VITE_SUPABASE_ANON_KEY',
  ].filter(Boolean);

  if (missing.length === 0) return;

  const message =
    `[lunadesk] Refusing to build a live bundle: ${missing.join(' and ')} ` +
    `${missing.length > 1 ? 'are' : 'is'} missing.\n\n` +
    '  Live mode needs both values in the build environment (repository secrets\n' +
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
