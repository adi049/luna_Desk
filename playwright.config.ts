import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for LunaDesk.
 *
 * They run against a real `vite preview` server in DEMO mode, so no Supabase
 * project and no credentials are involved: the demo adapter is fully
 * client-side. That is the only mode that can be exercised reproducibly in CI.
 *
 *   npx playwright install chromium     # once
 *   npm run test:e2e
 *
 * Live-mode behaviour (real sign-in, PostgREST, Edge Functions) is NOT covered
 * here and cannot be without a Supabase project — see docs/AUDIT.md.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    // Vite preview is started by the command below with BASE_PATH=/, so the
    // app is rooted at / — matching a user/organisation Pages site.
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run build:demo && npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    // Always start a fresh server. Reusing an existing one bit us: a `vite
    // preview` left over from a manual session served a stale bundle, every
    // route-level assertion failed, and the cause was not visible in the test
    // output. A deterministic gate is worth the few seconds of build time.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      // Demo mode needs no Supabase configuration at all.
      VITE_DATA_MODE: 'demo',
      BASE_PATH: '/',
    },
  },
});
