import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ConversationView } from './components/ConversationView.js';
import { DeviceSyncRunner } from './components/DeviceSyncRunner.js';
import { LockOverlay } from './components/LockOverlay.js';
import { AppShell } from './pages/AppShell.js';
import { EnrollmentPage } from './pages/Enrollment.js';
import { AccountPage } from './pages/Account.js';
import { AdminPage } from './pages/Admin.js';
import { InboxPage, QuickSwitcher, SearchModal } from './pages/Inbox.js';
import { InstallPage } from './pages/Install.js';
import { NotificationPrefsPage } from './pages/NotificationPrefs.js';
import { LoginPage } from './pages/Login.js';
import { AuthProvider, useAuth } from './state/auth.js';
import { CryptoProvider, useCrypto } from './state/crypto.js';
import { RealtimeProvider } from './state/realtime.js';
import { SearchProvider, useSearch } from './state/searchContext.js';
import { ThemeProvider } from './state/theme.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Socket.io pushes realtime updates for messages / presence / typing /
      // device-revokes, so we don't need to refetch every query on window refocus.
      // Reconnects trigger a targeted invalidation from RealtimeProvider.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

function Protected({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useAuth();
  const { hasDevice, deviceChecked } = useCrypto();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  // Wait for the IndexedDB device-record lookup before deciding. Otherwise the
  // first render (device still null) bounces the user to /enrollment even when
  // they DO have an enrolled device — which is why refresh always fell into
  // "Unlock this device" rather than reopening the tab they were on.
  if (!deviceChecked) return <FullScreenSpinner />;
  if (!hasDevice) return <Navigate to="/enrollment" replace />;
  return children;
}

function InstallGate({ children }: { children: JSX.Element }): JSX.Element {
  const loc = useLocation();
  const [state, setState] = useState<'loading' | 'needs-install' | 'ready' | 'backend-down'>(
    'loading',
  );
  // Fetch /install/status exactly once on mount. Previously we re-polled on every
  // route change, which put the endpoint on the hot path during normal navigation.
  // The wizard explicitly transitions state via navigate() on success so we don't
  // need to re-poll to learn installed=true.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.installStatus();
        if (cancelled) return;
        setState(s.installed ? 'ready' : 'needs-install');
      } catch {
        if (cancelled) return;
        // Previously we silently set state=ready on fetch failure, which
        // masked real backend outages and let users attempt to log in
        // against a dead API. Surface the outage so the operator sees it.
        setState('backend-down');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // After the install wizard completes it navigates to /login — mark ready so
  // subsequent pathname changes don't bounce back to /setup.
  useEffect(() => {
    if (state === 'needs-install' && loc.pathname === '/login') setState('ready');
  }, [loc.pathname, state]);
  if (state === 'loading') return <FullScreenSpinner />;
  if (state === 'backend-down') {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 px-4">
        <div className="max-w-md text-center space-y-3">
          <div className="text-3xl">⚠️</div>
          <h1 className="text-lg font-semibold text-slate-800">Can&apos;t reach the server</h1>
          <p className="text-sm text-slate-600">
            The Vibe Connect appliance isn&apos;t responding at <code>/install/status</code>. Check
            that the app container is running and refresh this page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-brand-600 text-white font-medium px-4 py-2 hover:bg-brand-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (state === 'needs-install' && loc.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }
  if (state === 'ready' && loc.pathname === '/setup') {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function FullScreenSpinner(): JSX.Element {
  return (
    <div className="min-h-screen grid place-items-center text-slate-500">
      <div className="text-sm">Loading…</div>
    </div>
  );
}

function ConversationPlaceholder(): JSX.Element {
  return (
    <div className="h-full grid place-items-center text-slate-500 text-sm p-6">
      <div className="max-w-md text-center space-y-3">
        <div className="text-3xl">💬</div>
        <div className="font-medium text-slate-700">Select a conversation to get started.</div>
        <ul className="text-xs text-slate-500 text-left list-disc pl-5 space-y-1">
          <li>Click a coworker in the left sidebar to open a direct message.</li>
          <li>Use <strong>Multi-select</strong> in the sidebar to start a group conversation.</li>
          <li>
            Press <kbd className="px-1 rounded bg-slate-100 border border-slate-200">Ctrl/⌘</kbd>+
            <kbd className="px-1 rounded bg-slate-100 border border-slate-200">K</kbd> to jump to
            an existing conversation, or{' '}
            <kbd className="px-1 rounded bg-slate-100 border border-slate-200">Ctrl/⌘</kbd>+
            <kbd className="px-1 rounded bg-slate-100 border border-slate-200">F</kbd> to search
            decrypted messages.
          </li>
          <li>
            No coworkers yet? Admins add them under{' '}
            <NavLink to="/admin/users" className="text-brand-700 hover:underline">
              Admin → Users
            </NavLink>
            .
          </li>
        </ul>
      </div>
    </div>
  );
}

function GlobalShortcuts(): JSX.Element {
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { search } = useSearch();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') {
        setQuickOpen(false);
        setSearchOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <QuickSwitcher open={quickOpen} onClose={() => setQuickOpen(false)} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} search={search} />
    </>
  );
}

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <CryptoProvider>
            <SearchProvider>
              <RealtimeProvider>
                <DeviceSyncRunner />
                <GlobalShortcuts />
                <LockOverlay />
                <InstallGate>
                <Routes>
                  <Route path="/setup" element={<InstallPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/enrollment" element={<EnrollmentPage />} />
                  <Route
                    path="/"
                    element={
                      <Protected>
                        <AppShell />
                      </Protected>
                    }
                  >
                    <Route index element={<ConversationPlaceholder />} />
                    <Route path="inbox" element={<InboxPage />} />
                    <Route path="conversation/:id" element={<ConversationView />} />
                    <Route path="admin/*" element={<AdminPage />} />
                    <Route path="account" element={<AccountPage />} />
                    <Route path="notifications" element={<NotificationPrefsPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
                </InstallGate>
              </RealtimeProvider>
            </SearchProvider>
          </CryptoProvider>
        </AuthProvider>
      </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
