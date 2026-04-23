import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, NavLink } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import { useRealtimeNotifications, useTabBadge } from '../state/notifications.js';

import { useState } from 'react';
import { useAddToHomeScreen } from '../state/pwa.js';

export function AppShell(): JSX.Element {
  const { user, logout } = useAuth();
  useRealtimeNotifications();
  const a2hs = useAddToHomeScreen();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const convs = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations().then((r) => r.conversations),
  });
  const totalUnread = useMemo(
    () => (convs.data ?? []).reduce((s, c) => s + c.unreadCount, 0),
    [convs.data],
  );
  useTabBadge(totalUnread);
  return (
    <div className="h-screen grid md:grid-cols-[280px_1fr] grid-rows-[52px_1fr] bg-slate-50">
      <header className="col-span-full row-start-1 flex items-center justify-between px-4 bg-white border-b border-slate-200">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Toggle sidebar"
            className="md:hidden w-8 h-8 grid place-items-center text-slate-600"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>
          <div className="w-7 h-7 rounded bg-brand-600 text-white grid place-items-center font-bold text-sm">
            VC
          </div>
          <span className="font-semibold text-slate-900">Vibe Connect</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline text-slate-600">{user?.displayName}</span>
          {a2hs.available && (
            <button
              type="button"
              onClick={() => void a2hs.promptInstall()}
              className="text-xs rounded bg-slate-100 px-2 py-1 hover:bg-slate-200"
            >
              Install app
            </button>
          )}
          <NavLink to="/notifications" className="text-brand-700 hover:underline">
            Notifications
          </NavLink>
          {user?.isAdmin && (
            <NavLink to="/admin" className="text-brand-700 hover:underline">
              Admin
            </NavLink>
          )}
          <button
            type="button"
            className="text-slate-500 hover:text-slate-800"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </div>
      </header>
      <aside
        className={`row-start-2 col-start-1 bg-white border-r border-slate-200 overflow-hidden ${
          sidebarOpen
            ? 'block absolute inset-y-12 left-0 w-[280px] z-20 shadow-xl'
            : 'hidden md:block'
        }`}
      >
        <Sidebar />
      </aside>
      <main
        className="row-start-2 md:col-start-2 overflow-hidden"
        onClick={() => setSidebarOpen(false)}
      >
        <Outlet />
      </main>
    </div>
  );
}
