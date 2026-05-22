/* global self, caches, fetch, URL */
/* eslint-disable no-restricted-globals, no-undef */
//
// Intake service worker (v0.4.32+).
//
// Purpose: complete the intake PWA — manifest was already there but
// without a service worker iOS Safari refuses to install the app to
// the home screen (the "Add to Home Screen" affordance saves a
// regular Safari bookmark instead of an installable PWA). Also gives
// the SPA an offline shell so a client who opens the installed icon
// while offline gets the intake UI rendered with a network-error
// state, instead of Safari's chromeless "no internet" page.
//
// Scope: registered at `_scoped('/')` which resolves to
// `<basepath>/intake/` because intake is mounted under nginx's
// `location ^~ /intake` block. The SW only intercepts fetches under
// that scope — /api/public/intake/* upload calls already live OUTSIDE
// the scope so they're naturally network-only with no exclusion list
// needed. The exclusion block below is defensive: if a future
// refactor moves an API endpoint into /intake/* by mistake, the SW
// would otherwise cache upload bytes, which would be both a privacy
// leak (intake is server-side-encrypted but plaintext-over-TLS) and
// a memory bomb (250 MB / file cap × N files).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function _scopePathname() {
  try {
    return new URL(self.registration.scope).pathname.replace(/\/$/, '');
  } catch (_e) {
    return '';
  }
}
function _scoped(path) {
  return _scopePathname() + path;
}

// --- Offline shell ---
const SHELL_CACHE = 'vibe-intake-shell-v1';
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
  // Bust prior intake caches on upgrade; leave non-intake caches alone
  // so a co-installed portal or staff SW on the same origin doesn't
  // lose its shell entries.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k.startsWith('vibe-intake-'))
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Network-only for anything API-shaped, even though /api lives
  // outside our scope today — see file header comment.
  const scopePrefix = _scopePathname();
  const relPath =
    scopePrefix && url.pathname.startsWith(scopePrefix + '/')
      ? url.pathname.slice(scopePrefix.length)
      : url.pathname;
  if (
    relPath.startsWith('/api') ||
    relPath.startsWith('/__vibe-boot.js') ||
    relPath.startsWith('/portal') ||
    relPath.startsWith('/auth')
  ) {
    return;
  }
  // Stale-while-revalidate for the SPA shell + Vite-emitted bundle
  // assets. Cached entry served instantly; network response updates
  // the cache for next time. Both miss → browser-native error.
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
