import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { DataProvider, ToastProvider } from './context/app';
import { AuthProvider } from './context/auth';
import { getAdapters, type Adapters } from './lib/data';
import { Spinner } from './components/ui';
import { registerServiceWorker } from './lib/push';

function Boot() {
  const [adapters, setAdapters] = useState<Adapters | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdapters()
      .then(setAdapters)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not start LunaDesk'));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="surface max-w-md p-6">
          <h1 className="text-base font-semibold text-fg">LunaDesk could not start</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <p className="mt-3 text-xs text-faint">
            Check that <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
            <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> are set, or run with{' '}
            <code className="font-mono">VITE_DATA_MODE=demo</code>.
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
