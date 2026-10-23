import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useData } from './app';
import type { Profile } from '@/lib/types';
import type { AccessResult } from '@/lib/data/types';

type Status = 'loading' | 'signedOut' | 'signedIn' | 'no-profile';

interface AuthApi {
  status: Status;
  profile: Profile | null;
  isAdmin: boolean;
  isClient: boolean;
  signInWithAccessCode(code: string): Promise<AccessResult>;
  signInAdminWithCode(code: string, password: string): Promise<AccessResult>;
  signInWithPassword(email: string, password: string): Promise<{ ok: boolean; error?: string }>;
  sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }>;
  signOut(): Promise<void>;
  reloadProfile(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { adapters } = useData();
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(
    async (userId: string | null) => {
      if (!userId) {
        setProfile(null);
        setStatus('signedOut');
        return;
      }
      try {
        const row = await adapters.data.get<Profile>('profiles', userId);
        if (!row) {
          setProfile(null);
          setStatus('no-profile');
          return;
        }
        if (row.is_active === false) {
          // Revoked access: end the session rather than leaving a dead shell open.
          await adapters.auth.signOut();
          setProfile(null);
          setStatus('signedOut');
          return;
        }
        setProfile(row);
        setStatus('signedIn');
      } catch {
        setProfile(null);
        setStatus('no-profile');
      }
    },
    [adapters],
  );

  useEffect(() => {
    let alive = true;
    adapters.auth.init().then((id) => {
      if (alive) void loadProfile(id);
    });
    const unsubscribe = adapters.auth.onAuthStateChange((id) => {
      void loadProfile(id);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [adapters, loadProfile]);

  const signInWithAccessCode = useCallback(
    async (code: string) => {
      const result = await adapters.auth.signInWithAccessCode(code);
      if (result.ok) await loadProfile(adapters.auth.getCurrentUserId());
      return result;
    },
    [adapters, loadProfile],
  );

  const signInAdminWithCode = useCallback(
    async (code: string, password: string) => {
      const result = await adapters.auth.signInAdminWithCode(code, password);
      if (result.ok) await loadProfile(adapters.auth.getCurrentUserId());
      return result;
    },
    [adapters, loadProfile],
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const result = await adapters.auth.signInWithPassword(email, password);
      if (result.ok) await loadProfile(adapters.auth.getCurrentUserId());
      return result;
    },
    [adapters, loadProfile],
  );

  const signOut = useCallback(async () => {
    await adapters.auth.signOut();
    setProfile(null);
    setStatus('signedOut');
  }, [adapters]);

  const value = useMemo<AuthApi>(
    () => ({
      status,
      profile,
      isAdmin: profile?.role === 'admin',
      isClient: profile?.role === 'client',
      signInWithAccessCode,
      signInAdminWithCode,
      signInWithPassword,
      sendMagicLink: adapters.auth.sendMagicLink.bind(adapters.auth),
      signOut,
      reloadProfile: async () => loadProfile(adapters.auth.getCurrentUserId()),
    }),
    [status, profile, signInWithAccessCode, signInAdminWithCode, signInWithPassword, signOut, adapters, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
