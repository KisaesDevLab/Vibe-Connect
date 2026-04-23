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
import { useAuth } from './auth.js';
import { SearchIndex, type IndexedEntry } from './search.js';

interface Ctx {
  ready: boolean;
  indexMessage: (entry: IndexedEntry) => void;
  removeMessage: (id: string) => void;
  search: (q: string, limit?: number) => IndexedEntry[];
  wipe: () => Promise<void>;
}

const C = createContext<Ctx | null>(null);

export function SearchProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const indexRef = useRef(new SearchIndex());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!user) {
      setReady(false);
      return;
    }
    void indexRef.current.load(user.id).then(() => setReady(true));
  }, [user]);

  const indexMessage = useCallback(
    (entry: IndexedEntry) => {
      indexRef.current.add(entry);
      if (user) void indexRef.current.persist(user.id);
    },
    [user],
  );
  const removeMessage = useCallback(
    (id: string) => {
      indexRef.current.remove(id);
      if (user) void indexRef.current.persist(user.id);
    },
    [user],
  );
  const search = useCallback((q: string, limit?: number) => indexRef.current.search(q, limit), []);
  const wipe = useCallback(async () => {
    await SearchIndex.wipeAll();
    indexRef.current = new SearchIndex();
  }, []);

  const value = useMemo(
    () => ({ ready, indexMessage, removeMessage, search, wipe }),
    [ready, indexMessage, removeMessage, search, wipe],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useSearch(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error('SearchProvider missing');
  return v;
}
