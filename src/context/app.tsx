import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { DATA_MODE, type Adapters } from '@/lib/data';
import type { ListOptions, TableName } from '@/lib/data/types';
import { cn } from '@/lib/utils';

export { DATA_MODE };

/* ------------------------------------------------------------------ *\
   Toasts
\* ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface ToastApi {
  push(kind: ToastKind, message: string, detail?: string): void;
  success(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
  warning(message: string, detail?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const toastIcon = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
  warning: AlertTriangle,
} as const;

const toastTone: Record<ToastKind, string> = {
  success: 'text-mint',
  error: 'text-magenta',
  info: 'text-sky',
  warning: 'text-butter',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      const id = ++idRef.current;
      setToasts((t) => [...t.slice(-3), { id, kind, message, detail }]);
      const ttl = kind === 'error' ? 7000 : 4200;
      window.setTimeout(() => remove(id), ttl);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (m, d) => push('success', m, d),
      error: (m, d) => push('error', m, d),
      info: (m, d) => push('info', m, d),
      warning: (m, d) => push('warning', m, d),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(92vw,22rem)] flex-col gap-2 no-print"
        role="region"
        aria-label="Notifications"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = toastIcon[t.kind];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }}
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                className="pointer-events-auto surface flex items-start gap-3 p-3 pr-2"
                role="status"
                aria-live="polite"
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', toastTone[t.kind])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug text-fg">{t.message}</p>
                  {t.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.detail}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => remove(t.id)}
                  className="rounded-md p-1 text-faint transition hover:bg-raised hover:text-fg"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/* ------------------------------------------------------------------ *\
   Data access: adapters + a revision counter that invalidates queries
\* ------------------------------------------------------------------ */

interface DataApi {
  adapters: Adapters;
  revision: number;
  invalidate(): void;
}

const DataContext = createContext<DataApi | null>(null);

export function DataProvider({ adapters, children }: { adapters: Adapters; children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const invalidate = useCallback(() => setRevision((r) => r + 1), []);
  const value = useMemo(() => ({ adapters, revision, invalidate }), [adapters, revision, invalidate]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
}

/** Shorthand for the read/write adapter. */
export function useAdapter() {
  return useData().adapters.data;
}

export interface QueryState<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches a table with the given options. Re-runs when the options, the
 * signed-in user, or the global revision change.
 */
export function useCollection<T>(table: TableName, opts: ListOptions = {}, enabled = true): QueryState<T> {
  const { adapters, revision } = useData();
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const key = JSON.stringify(opts);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    adapters.data
      .list<T>(table, JSON.parse(key) as ListOptions)
      .then((rows) => {
        if (!cancelled) {
          setData(rows);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapters, table, key, enabled, revision, localRevision]);

  const refresh = useCallback(() => setLocalRevision((r) => r + 1), []);
  return { data, loading, error, refresh };
}

/* ------------------------------------------------------------------ *\
   Theme
\* ------------------------------------------------------------------ */

export type ThemeChoice = 'dark' | 'light' | 'system';

const THEME_KEY = 'lunadesk.theme';

function resolvedTheme(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem(THEME_KEY) as ThemeChoice | null;
    return stored ?? 'dark';
  });

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(choice);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    localStorage.setItem(THEME_KEY, next);
    setChoiceState(next);
  }, []);

  return { choice, setChoice, resolved: resolvedTheme(choice) };
}

/* ------------------------------------------------------------------ *\
   Reduced motion preference (used to gate decorative 3D)
\* ------------------------------------------------------------------ */

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
