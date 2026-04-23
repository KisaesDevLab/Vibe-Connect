import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ConversationView } from './components/ConversationView.js';
import { AppShell } from './pages/AppShell.js';
import { EnrollmentPage } from './pages/Enrollment.js';
import { AdminPage } from './pages/Admin.js';
import { InboxPage, QuickSwitcher, SearchModal } from './pages/Inbox.js';
import { NotificationPrefsPage } from './pages/NotificationPrefs.js';
import { LoginPage } from './pages/Login.js';
import { AuthProvider, useAuth } from './state/auth.js';
import { CryptoProvider, useCrypto } from './state/crypto.js';
import { RealtimeProvider } from './state/realtime.js';
import { SearchProvider, useSearch } from './state/searchContext.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function Protected({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useAuth();
  const { hasDevice } = useCrypto();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!hasDevice) return <Navigate to="/enrollment" replace />;
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
    <div className="h-full grid place-items-center text-slate-500 text-sm">
      <div>
        <div>Select a conversation from the sidebar.</div>
        <div className="mt-2 text-slate-400">(Sidebar + view arrive in Phase 7 + 8.)</div>
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
      <BrowserRouter>
        <AuthProvider>
          <CryptoProvider>
            <SearchProvider>
              <RealtimeProvider>
                <GlobalShortcuts />
                <Routes>
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
                    <Route path="notifications" element={<NotificationPrefsPage />} />
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </RealtimeProvider>
            </SearchProvider>
          </CryptoProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
