import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, NavLink } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { api } from '../api.js';
import { useAuth } from '../state/auth.js';
import {
  useDeviceHeartbeat,
  useRealtimeNotifications,
  useTabBadge,
} from '../state/notifications.js';
import { useCrypto } from '../state/crypto.js';
import { useRealtime } from '../state/realtime.js';
import { url } from '../lib/boot.js';

import { useEffect, useRef, useState } from 'react';
import { useAddToHomeScreen } from '../state/pwa.js';
import { useTheme } from '../state/theme.js';

function ConnectionDot({
  status,
}: {
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
}): JSX.Element | null {
  if (status === 'connected') {
    // Don't clutter the header while things are healthy; hover-only tooltip.
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-emerald-500"
        title="Connected"
        aria-label="Connected"
      />
    );
  }
  const dot =
    status === 'connecting'
      ? 'bg-slate-400 animate-pulse'
      : status === 'reconnecting'
        ? 'bg-amber-500 animate-pulse'
        : 'bg-rose-500';
  const label =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : 'Disconnected — messages may be stale';
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-600">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}

function SignOutMenu({
  onSignOut,
}: {
  onSignOut: (forgetDevice: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="text-slate-500 hover:text-slate-800"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Sign out ▾
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-popover z-30 text-sm overflow-hidden">
          {/*
            Download Desktop link. The href is computed via url('/desktop/')
            so it picks up BASE_PATH at runtime — single-app sees /desktop/,
            multi-app sees /connect/desktop/. nginx 302s either to GitHub
            releases or to whatever DESKTOP_DOWNLOAD_URL the operator
            pinned. target=_blank because the redirect target is off-host
            and we don't want to navigate the staff app away from itself.
            Hidden in the portal SPA — this menu only renders in apps/web.
          */}
          <a
            href={url('/desktop/')}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="block w-full text-left px-3 py-2 hover:bg-slate-50 text-slate-700 border-b border-slate-100"
          >
            <div className="font-medium">Download Desktop</div>
            <div className="text-xs text-slate-500">
              Windows installer for the Vibe Connect desktop app.
            </div>
          </a>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut(false);
            }}
            className="block w-full text-left px-3 py-2 hover:bg-slate-50 text-slate-700"
          >
            <div className="font-medium">Sign out</div>
            <div className="text-xs text-slate-500">Keep this device enrolled on this browser.</div>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSignOut(true);
            }}
            className="block w-full text-left px-3 py-2 hover:bg-rose-50 text-rose-700 border-t border-slate-100"
          >
            <div className="font-medium">Sign out &amp; forget device</div>
            <div className="text-xs text-rose-600/80">
              Use on shared or public computers. You will need to re-enroll and unlock with your passphrase next time.
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell(): JSX.Element {
  const { user, logout } = useAuth();
  useRealtimeNotifications();
  const a2hs = useAddToHomeScreen();
  const { effective, toggle: toggleTheme } = useTheme();
  const { device, lock, hasDevice } = useCrypto();
  const { connectionStatus } = useRealtime();
  useDeviceHeartbeat(device?.deviceId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const convs = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.listConversations(),
  });
  // Firm-level chrome label. Falls back to "Vibe Connect" when the admin
  // hasn't set an override (or while the policy is still loading) so the
  // header never flashes empty.
  const policy = useQuery({
    queryKey: ['security-policy'],
    queryFn: () => api.getSecurityPolicy(),
    staleTime: 60_000,
  });
  const appName = policy.data?.appName?.trim() || 'Vibe Connect';
  const appBadge = useMemo(() => initialsFor(appName), [appName]);
  const totalUnread = useMemo(
    () => (convs.data?.conversations ?? []).reduce((s, c) => s + c.unreadCount, 0),
    [convs.data],
  );
  useTabBadge(totalUnread, appName);
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
            {appBadge}
          </div>
          <span className="font-semibold text-slate-900">{appName}</span>
          <ConnectionDot status={connectionStatus} />
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
          <NavLink to="/account" className="text-brand-700 hover:underline">
            Account
          </NavLink>
          {policy.data?.requestsEnabled !== false && (
            <NavLink to="/requests" className="text-brand-700 hover:underline">
              Requests
            </NavLink>
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
            onClick={toggleTheme}
            aria-label={`Switch to ${effective === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${effective === 'dark' ? 'light' : 'dark'} mode`}
            className="text-slate-500 hover:text-slate-800 w-7 h-7 grid place-items-center"
          >
            {effective === 'dark' ? '☀' : '☾'}
          </button>
          {hasDevice && (
            <button
              type="button"
              onClick={lock}
              aria-label="Lock session"
              title="Lock (requires passphrase to unlock)"
              className="text-slate-500 hover:text-slate-800 w-7 h-7 grid place-items-center"
            >
              🔒
            </button>
          )}
          <SignOutMenu
            onSignOut={(forgetDevice) => void logout({ forgetDevice })}
          />
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

// Tiny helper for the square brand badge to the left of the app name. Picks
// up to two letters from the configured app name (first letter of the first
// word + first letter of the last word when there's more than one). Strips
// non-letters so emoji-suffixed names like "Acme 🚀" still produce "A".
function initialsFor(name: string): string {
  const words = name
    .replace(/[^A-Za-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'VC';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
