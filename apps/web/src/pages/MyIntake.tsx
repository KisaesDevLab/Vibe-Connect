import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useAuth } from '../state/auth.js';
import { getBoot } from '../lib/boot.js';
import { AdminIntakeSessions, AdminIntakeLinks } from './Admin.js';

/**
 * Build the public-facing URL for an intake path (e.g. `/intake` or
 * `/intake/<staffId>`) for display in the staff's "My intake page" card.
 *
 * Derives the URL from the browser's actual origin + the SPA's basePath
 * rather than trusting `boot.siteUrl`. SITE_URL is operator-set on the
 * appliance and frequently misconfigured (falls through to the dev
 * default `http://localhost:4000` if the appliance bootstrap doesn't
 * derive it from the subdomain template). When that happens, this
 * card would otherwise surface a localhost URL to a staff member who's
 * browsing from a real public hostname — confusing and useless.
 *
 * window.location.origin is the source of truth for "where the staff
 * member's browser is right now", and boot.basePath is already correctly
 * derived by /__vibe-boot.js. The two together produce the right URL in
 * every deployment where clients and staff hit the same hostname, which
 * is effectively all of them.
 *
 * SSR/test fallback: when window is undefined or origin is empty, fall
 * back to the old boot.siteUrl path so unit tests don't break.
 */
function publicIntakeUrl(path: string): string {
  const boot = getBoot();
  const suffix = path.startsWith('/') ? path : '/' + path;
  if (typeof window !== 'undefined' && window.location.origin) {
    const base = boot.basePath || '';
    return `${window.location.origin}${base}${suffix}`;
  }
  return `${boot.siteUrl.replace(/\/$/, '')}${suffix}`;
}

const tabs = [
  { path: 'files', label: 'Files' },
  { path: 'links', label: 'Links' },
  { path: 'my-page', label: 'My intake page' },
] as const;

export function MyIntakePage(): JSX.Element {
  const loc = useLocation();
  const { user } = useAuth();

  if (user && !user.showOnIntakeCard) {
    // A staff member who turned off intake visibility shouldn't have a route
    // either — the nav link is already gated on showOnIntakeCard but a deep
    // link or stale tab could still get here. Send them to Account where they
    // can flip the toggle back on.
    return <Navigate to="/account" replace />;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-slate-200 bg-white px-4 overflow-x-auto">
        <nav className="flex gap-2 min-w-max">
          {tabs.map((t) => (
            <NavLink
              key={t.path}
              to={`/my-intake/${t.path}`}
              className={({ isActive }) =>
                clsx(
                  'px-3 py-3 text-sm whitespace-nowrap',
                  isActive || loc.pathname.endsWith(t.path)
                    ? 'border-b-2 border-brand-600 text-brand-800 font-medium'
                    : 'text-slate-600 hover:text-slate-900',
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Routes>
          <Route index element={<Navigate to="files" replace />} />
          <Route path="files" element={<AdminIntakeSessions />} />
          <Route path="links" element={<AdminIntakeLinks />} />
          <Route path="my-page" element={<MyIntakeUrlCard />} />
        </Routes>
      </div>
    </div>
  );
}

function MyIntakeUrlCard(): JSX.Element {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const myUrl = user ? publicIntakeUrl(`/intake/${user.id}`) : '';
  const landingUrl = publicIntakeUrl('/intake');

  async function copy(): Promise<void> {
    if (!myUrl) return;
    try {
      await navigator.clipboard.writeText(myUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Fallback path — older browsers without clipboard API. Select the
      // text into the URL input so the user can Ctrl-C manually.
      const input = document.getElementById('my-intake-url') as HTMLInputElement | null;
      input?.select();
    }
  }

  // Open the intake URL in the user's default browser. In a plain PWA tab
  // this is just window.open with noopener; in the Tauri desktop shell a
  // bare `target="_blank"` either replaces the appliance webview or
  // silently no-ops, so we route through tauri-plugin-shell's `open()`
  // which delegates to the OS shell. Runtime detection only — the plugin
  // import is static (small bundle) but the call is gated so non-Tauri
  // callers never invoke the IPC.
  async function openExternal(): Promise<void> {
    if (!myUrl) return;
    const inTauri =
      typeof window !== 'undefined' &&
      // Tauri 2 sets __TAURI_INTERNALS__; v1 used __TAURI__. Check both so
      // a future webview downgrade or partial migration still routes to the
      // shell opener instead of clobbering the appliance webview.
      (Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
        Boolean((window as { __TAURI__?: unknown }).__TAURI__));
    if (inTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(myUrl);
        return;
      } catch {
        // Plugin invocation failed (capability missing on a stale desktop
        // build, IPC unavailable, etc.). Fall through to window.open so the
        // user still gets something — worst case they see the appliance
        // navigate away, which is the pre-fix behavior.
      }
    }
    window.open(myUrl, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="p-4 max-w-3xl space-y-4">
      <header className="space-y-1">
        <h2 className="font-semibold text-slate-900">Your intake page</h2>
        <p className="text-sm text-slate-600">
          Share this link so clients can send you documents directly. Files arrive in the{' '}
          <strong>Files</strong> tab on this page and trigger a notification per your{' '}
          <NavLink to="/notifications" className="text-brand-700 hover:underline">
            notification settings
          </NavLink>
          .
        </p>
      </header>

      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3 shadow-card">
        <label className="block text-xs font-medium text-slate-500" htmlFor="my-intake-url">
          Direct URL
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            id="my-intake-url"
            type="text"
            readOnly
            value={myUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md bg-brand-600 text-white text-sm font-medium px-3 py-2 hover:bg-brand-700"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => void openExternal()}
            disabled={!myUrl}
            className="rounded-md border border-slate-300 bg-white text-sm font-medium px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
          >
            Open
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Or share the landing page at <span className="font-mono">{landingUrl}</span> — clients
          pick you from the staff list there.
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium mb-1">Want to change how clients see you?</p>
        <p>
          Your photo, title, and bio on the public intake page are edited under{' '}
          <NavLink to="/account" className="text-brand-700 hover:underline">
            Account → Intake card
          </NavLink>
          . Turning that off removes you from the public list and hides this section.
        </p>
      </div>
    </div>
  );
}
