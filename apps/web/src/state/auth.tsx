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
  logout: () => Promise<void>;
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

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    // Wipe readable client-side caches. Loaded async to avoid circular deps.
    void import('./search.js').then((m) => m.SearchIndex.wipeAll().catch(() => null));
  }, []);

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
