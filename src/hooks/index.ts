import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small, dependency-free hooks used across LunaDesk.
 *
 * Anything that touches a browser API degrades gracefully when the API is
 * missing (SSR, older browsers), and every listener is cleaned up so a route
 * change never leaves timers behind.
 */

/** Delay a fast-changing value — used for search boxes so filtering does not run per keystroke. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/** setInterval with a stable callback reference (no stale closures, no re-subscribe per render). */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null) return;
    const id = window.setInterval(() => saved.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

/** Tracks navigator.onLine. Being online is not the same as "the server is reachable". */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}

/**
 * Register a keyboard shortcut, e.g. useHotkeys({ 'mod+k': openPalette }).
 * Ignored while typing in a field unless `allowInInputs` is set.
 */
export function useHotkeys(
  map: Record<string, (event: KeyboardEvent) => void>,
  options: { allowInInputs?: boolean } = {},
): void {
  const saved = useRef(map);

  useEffect(() => {
    saved.current = map;
  }, [map]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;

      if (typing && !options.allowInInputs) return;

      const key = [
        event.metaKey || event.ctrlKey ? 'mod' : null,
        event.shiftKey ? 'shift' : null,
        event.altKey ? 'alt' : null,
        event.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');

      const action = saved.current[key] ?? saved.current[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        action(event);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [options.allowInInputs]);
}

/** Set document.title and restore the previous one on unmount. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * Async loader with explicit states — used where a one-off query is simpler
 * than subscribing to a whole collection.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    setError(null);

    loader()
      .then((result) => {
        if (alive.current) setData(result);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(err instanceof Error ? err.message : 'Something went wrong');
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });

    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
