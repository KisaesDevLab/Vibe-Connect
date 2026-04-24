// Light/dark theme toggle with localStorage persistence and system fallback.
// Apply via `html.classList.add('dark')`; Tailwind picks up the `dark:` variants.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Mode = 'light' | 'dark' | 'system';

interface ThemeCtx {
  mode: Mode;
  effective: 'light' | 'dark';
  setMode: (m: Mode) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const STORAGE_KEY = 'vibe-connect:theme';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function apply(mode: Mode): 'light' | 'dark' {
  const effective = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
  const root = document.documentElement;
  root.classList.toggle('dark', effective === 'dark');
  return effective;
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<Mode>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });
  const [effective, setEffective] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setEffective(apply(mode));
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setEffective(apply('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    window.localStorage.setItem(STORAGE_KEY, m);
  }, []);

  const toggle = useCallback(() => {
    setMode(effective === 'dark' ? 'light' : 'dark');
  }, [effective, setMode]);

  const value = useMemo(() => ({ mode, effective, setMode, toggle }), [mode, effective, setMode, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('ThemeProvider missing');
  return v;
}
