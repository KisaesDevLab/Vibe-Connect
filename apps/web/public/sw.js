/* global self, clients, caches, fetch, URL */
/* eslint-disable no-restricted-globals, no-undef */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// Scope-aware path helper. self.registration.scope is the absolute URL
// the SW is registered under — `https://server/` in single-app mode,
// `https://server/connect/` under the Vibe-Appliance path-mount.
// Prepending the scope's pathname to every static asset reference keeps
// cache keys aligned with the URLs the browser actually fetches —
// without this, multi-app deployments cache `/manifest.webmanifest` and
// then never serve the cached entry because the real fetch goes to
// `/connect/manifest.webmanifest`, which silently degrades the PWA
// install + offline-shell flow.
function _scopePathname() {
  try {
    // Strip the trailing slash so concatenation produces clean
    // paths like '/connect/manifest.webmanifest' rather than
    // '/connect//manifest.webmanifest'.
    return new URL(self.registration.scope).pathname.replace(/\/$/, '');
  } catch (_e) {
    return '';
  }
}
function _scoped(path) {
  // path is expected to start with '/' (caller's responsibility — we
  // don't want to silently absorb relative paths that may have been
  // intended as origin-relative).
  return _scopePathname() + path;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    // ignore malformed payload
  }
  const title = data.urgent ? 'Urgent message' : 'New message';
  const options = {
    body: data.senderDisplayName ? `From ${data.senderDisplayName}` : 'Tap to open',
    icon: _scoped('/favicon.svg'),
    badge: _scoped('/favicon.svg'),
    tag: data.conversationId || 'vibe-connect',
    data: { conversationId: data.conversationId, messageId: data.messageId },
    requireInteraction: Boolean(data.urgent),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    event.notification.data && event.notification.data.conversationId
      ? _scoped(`/conversation/${event.notification.data.conversationId}`)
      : _scoped('/');
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.focus();
          w.navigate(target);
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    }),
  );
});

// --- Phase 14: offline shell + stale-while-revalidate for static assets ---
//
// SHELL_PATHS are seeded under the SW's registered scope (single-app:
// `/`, multi-app: `/connect/`). Computed at install time — not at
// module load — so a future scope-rotation (operator moves BASE_PATH
// from `/connect` to `/connect-v2`) is picked up by the next SW
// install without a code patch. Failing the install on cache.addAll
// is acceptable per the prior catch(() => null) shape: SW activates
// without the offline shell, fetch handler still works via network.
const SHELL_CACHE = 'vibe-shell-v1';
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
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k.startsWith('vibe-'))
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache auth/API/socket traffic. Only static assets + shell.
  // The startsWith checks are scope-relative: in multi-app mode the
  // real pathname is `/connect/auth/login`, NOT `/auth/login` — so we
  // strip the scope prefix before comparing. Without this, multi-app
  // deployments cache POST-once GET-once auth responses and the user
  // ends up logged in as whoever made the previous request.
  const scopePrefix = _scopePathname();
  const relPath =
    scopePrefix && url.pathname.startsWith(scopePrefix + '/')
      ? url.pathname.slice(scopePrefix.length)
      : url.pathname;
  if (
    relPath.startsWith('/auth') ||
    relPath.startsWith('/conversations') ||
    relPath.startsWith('/users') ||
    relPath.startsWith('/groups') ||
    relPath.startsWith('/admin') ||
    relPath.startsWith('/notifications') ||
    relPath.startsWith('/attachments') ||
    relPath.startsWith('/socket.io') ||
    relPath.startsWith('/firm')
  ) {
    return;
  }
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
