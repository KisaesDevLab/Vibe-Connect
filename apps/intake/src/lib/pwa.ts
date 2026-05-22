// Service worker registration for the intake PWA.
//
// Manifest has been in place since Phase 28.17 but iOS Safari needs
// a registered service worker before "Add to Home Screen" treats the
// site as an installable PWA (vs. a chromeless bookmark). See
// apps/intake/public/sw.js for what the SW does — short version is
// offline-shell-only; /api/public/intake/* upload calls are never
// cached.
import { url } from './boot.js';

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Both path AND scope honour the runtime BASE_PATH via url(). The
  // intake bundle lives under `<basepath>/intake/` so both resolve to
  // that prefix; the SW's _scopePathname helper reads back from
  // self.registration.scope at request time so cache keys align with
  // the URLs the browser actually fetches.
  const swPath = url('/intake/sw.js');
  const swScope = url('/intake/');
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swPath, { scope: swScope }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('intake sw registration failed', err);
    });
  });
}
