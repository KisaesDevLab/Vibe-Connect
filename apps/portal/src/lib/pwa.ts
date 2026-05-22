// Service worker registration for the portal PWA.
//
// Mirrors apps/web/src/state/pwa.ts but lighter — the portal doesn't
// (yet) use Web Push so there's no per-subscription state to manage,
// just registration. See apps/portal/public/sw.js for what the SW
// actually does and what it does NOT cache (everything under /portal,
// /auth, /socket.io, /__vibe-boot.js is network-only by design).
import { url } from './boot.js';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Both the script path AND the scope must honour PORTAL_BASE_PATH.
  // In the two-subdomain appliance (vibe.<domain>/connect/ for staff,
  // client.<domain>/ for portal) the portal listens at root '/', so
  // url('/sw.js') resolves to /sw.js. In single-app mode that's the
  // same. The scope option pins the SW to the prefix so Chrome
  // doesn't refuse to register a script whose path is more specific
  // than the page's directory.
  const swPath = url('/sw.js');
  const swScope = url('/');
  // Wait until after `load` so the registration doesn't race with the
  // initial app bootstrap (libsodium init, /__vibe-boot.js fetch).
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swPath, { scope: swScope }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('portal sw registration failed', err);
    });
  });
}
