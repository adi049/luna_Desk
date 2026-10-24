import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { DataProvider, ToastProvider } from './context/app';
import { AuthProvider } from './context/auth';
import { getAdapters, type Adapters } from './lib/data';
import { Spinner } from './components/ui';
import { registerServiceWorker } from './lib/push';

/**
 * Configuration is checked before anything is fetched.
 *
 * Without this, a build with a missing (or http://) Supabase URL renders the
 * sign-in form and then fails one request at a time, which reads as "the app is
 * broken" instead of "one secret is wrong". The build-time gate lives in
 * scripts/check-env.mjs; this is the runtime backstop for a bundle that was
 * built by hand.
 */
function configurationProblem(): string | null {
  const mode = import.meta.env.VITE_DATA_MODE as string | undefined;
  if (mode === 'demo') return null;

  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

  if (!url || !key) {
    return 'This build has no Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or build with VITE_DATA_MODE=demo), then rebuild.';
  }
  if (!/^https:\/\//i.test(url)) {
    return `VITE_SUPABASE_URL must be an https:// address; this build points at "${url}".`;
  }
  if (/^sb_secret_/.test(key)) {
    return 'VITE_SUPABASE_ANON_KEY looks like a secret key. Only anon / publishable keys may be shipped to the browser.';
  }
  return null;
}

function Boot() {
  const [adapters, setAdapters] = useState<Adapters | null>(null);
  const [error, setError] = useState<string | null>(configurationProblem);

  useEffect(() => {
    getAdapters()
      .then(setAdapters)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not start LunaDesk'));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="surface max-w-md p-6" role="alert">
          <h1 className="text-base font-semibold text-fg">LunaDesk could not start</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <p className="mt-3 text-xs text-faint">
            Check that <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
            <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> are set, or run with{' '}
            <code className="font-mono">VITE_DATA_MODE=demo</code>.{' '}
            <code className="font-mono">npm run check:env</code> validates the same rules
            before a deploy.
          </p>
        </div>
      </div>
    );
  }

  if (!adapters) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Starting LunaDesk" />
      </div>
    );
  }

  return (
    <ToastProvider>
      <DataProvider adapters={adapters}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </DataProvider>
    </ToastProvider>
  );
}

// The service worker is only useful in a built deployment (Web Push + PWA
// install). Registering it in dev would cache a half-finished build, so it is
// skipped there on purpose.
if (import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
