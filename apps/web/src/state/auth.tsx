// Authenticated-user context for the staff app.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PublicUser } from '@vibe-connect/shared-types';
import { api } from '../api.js';

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  error: Error | null;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Sign out. When `forgetDevice` is true, also wipes the locally-stored device
   * record (IndexedDB) — appropriate for shared or public workstations. The
   * wrapped private key would otherwise survive sign-out; Argon2id slows offline
   * attacks but does not eliminate them for weak passphrases.
   */
  logout: (opts?: { forgetDevice?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { user } = await api.me();
      setUser(user);
      setError(null);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401) setUser(null);
      else setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    const { user } = await api.login(username, password);
    setUser(user);
  }, []);

  const logout = useCallback(
    async (opts?: { forgetDevice?: boolean }) => {
      const userId = user?.id;
      await api.logout();
      setUser(null);
      // Always wipe readable client-side caches. Loaded async to avoid circular deps.
      void import('./search.js').then((m) => m.SearchIndex.wipeAll().catch(() => null));
      if (opts?.forgetDevice && userId) {
        void import('./crypto.js').then((m) => m.wipeDeviceSecrets(userId).catch(() => null));
      }
    },
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, error, login, logout, refresh }),
    [user, loading, error, login, logout, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
