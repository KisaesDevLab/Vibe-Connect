/* global self, clients, caches, fetch, URL */
/* eslint-disable no-restricted-globals, no-undef */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

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
    icon: '/favicon.svg',
    badge: '/favicon.svg',
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
      ? `/conversation/${event.notification.data.conversationId}`
      : '/';
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
const SHELL_CACHE = 'vibe-shell-v1';
const SHELL_PATHS = ['/', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_PATHS))
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
  if (
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/conversations') ||
    url.pathname.startsWith('/users') ||
    url.pathname.startsWith('/groups') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/notifications') ||
    url.pathname.startsWith('/attachments') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/firm')
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
