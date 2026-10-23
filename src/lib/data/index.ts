/**
 * Adapter selection.
 *
 * VITE_DATA_MODE=demo  → local, clearly-labelled demo dataset (no network).
 * VITE_DATA_MODE=live  → Supabase (requires URL + publishable key).
 *
 * The demo module is loaded with a dynamic import so a live production build
 * never ships the fictional dataset in its main bundle.
 */
import type { AuthAdapter, DataAdapter } from './types';

export interface Adapters {
  data: DataAdapter;
  auth: AuthAdapter;
  mode: 'live' | 'demo';
}

// Live is the default. Demo must be asked for explicitly, and only a build that
// sets VITE_DATA_MODE=demo can ever show the fictional dataset — so a
// misconfigured production deploy fails loudly instead of quietly serving demo
// data as if it were real.
export const DATA_MODE: 'live' | 'demo' =
  (import.meta.env.VITE_DATA_MODE as 'live' | 'demo' | undefined) === 'demo' ? 'demo' : 'live';

let cached: Promise<Adapters> | null = null;

export function getAdapters(): Promise<Adapters> {
  if (!cached) {
    cached = (async () => {
      if (DATA_MODE === 'live') {
        const { SupabaseAdapter, SupabaseAuth } = await import('./supabase');
        return { data: new SupabaseAdapter(), auth: new SupabaseAuth(), mode: 'live' as const };
      }
      const { DemoAdapter, DemoAuth } = await import('./demo');
      return { data: new DemoAdapter(), auth: new DemoAuth(), mode: 'demo' as const };
    })();
  }
  return cached;
}

/** Test seam: allows swapping in a stub adapter during unit tests. */
export function __setAdapters(next: Adapters | null) {
  cached = next ? Promise.resolve(next) : null;
}
