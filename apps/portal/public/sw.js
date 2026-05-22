/* global self, caches, fetch, URL */
/* eslint-disable no-restricted-globals, no-undef */
//
// Portal service worker (v0.4.32+).
//
// Purpose: make the portal installable as a real PWA on iOS / Android
// (iOS requires manifest + SW + a prior page visit before "Add to
// Home Screen" works) and serve a cached app shell so a client
// re-opening the installed icon while offline gets the SPA chrome
// instead of Safari's "no internet" page. The shell is just the
// initial HTML + favicon + manifest — once the SPA loads, every API
// call (`/portal/*`) goes straight to the network with no caching.
//
// What this SW deliberately does NOT cache:
//   - /portal/me, /portal/conversations*, /portal/identify, /portal/verify
//     — all session-bound + carry per-user state. Caching them would
//     surface another user's session to whoever opens the app next.
//   - /portal/conversations/*/messages — ciphertext we don't decrypt
//     here, but caching messages would silently extend their lifetime
//     past server-side retention sweeps.
//   - /portal/conversations/attachments/* — encrypted file blobs that
//     can be tens of MB; the cache would balloon for power users.
//   - /auth/* — staff endpoints that should never appear on the portal
//     subdomain, but block defensively anyway.
//
// Mirrors apps/web/public/sw.js's scope-aware path helper because the
// portal SPA also rides nginx sub_filter substitution under multi-app
// deployments (BASE_PATH=/connect strips → cache keys must match).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Scope-aware path helper. self.registration.scope is the absolute URL
// the SW is registered under — `https://server/` in single-app mode,
// `https://server/<basepath>/` in multi-app. Prepending the scope's
// pathname to every static asset reference keeps cache keys aligned
// with the URLs the browser actually fetches.
function _scopePathname() {
  try {
    return new URL(self.registration.scope).pathname.replace(/\/$/, '');
  } catch (_e) {
    return '';
  }
}
function _scoped(path) {
  // Caller passes a leading-slash path; we avoid silently absorbing
  // relative paths that may have been intended as origin-relative.
  return _scopePathname() + path;
}

// --- Offline shell ---
//
// Computed at install time so a future scope change (operator
// reconfigures PORTAL_BASE_PATH) takes effect on next SW install
// without a code patch.
const SHELL_CACHE = 'vibe-portal-shell-v1';
function _shellPaths() {
  return [_scoped('/'), _scoped('/manifest.webmanifest'), _scoped('/favicon.svg')];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(_shellPaths()))
      .catch(() => null),
  );
});

self.addEventListener('activate', (event) => {
  // Drop any prior portal caches that don't match the current version
  // (cache-busting on SW upgrade). Limit deletion to vibe-portal-*
  // entries so a co-installed staff SW (apex / hash collisions) keeps
  // its own caches intact.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k.startsWith('vibe-portal-'))
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache portal API / auth traffic. Strip the scope prefix
  // before comparing so multi-app deployments compare the right
  // path (real pathname is `/connect/portal/...` not `/portal/...`).
  const scopePrefix = _scopePathname();
  const relPath =
    scopePrefix && url.pathname.startsWith(scopePrefix + '/')
      ? url.pathname.slice(scopePrefix.length)
      : url.pathname;
  if (
    relPath.startsWith('/portal') ||
    relPath.startsWith('/auth') ||
    relPath.startsWith('/socket.io') ||
    relPath.startsWith('/__vibe-boot.js')
  ) {
    return;
  }
  // Stale-while-revalidate for the SPA shell + static assets. Cached
  // entry served instantly; network response updates the cache for
  // next time. If both miss, the browser sees a network error — same
  // as without an SW.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
