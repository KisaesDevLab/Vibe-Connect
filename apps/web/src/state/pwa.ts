// Service worker registration + "Add to home screen" prompt tracker.
import { useEffect, useState } from 'react';
import { url } from '../lib/boot.js';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Both the script path AND the scope must honour BASE_PATH. On the
  // multi-app appliance the staff bundle lives under /connect/, the
  // upstream Caddy strips /connect before forwarding, so a raw `/sw.js`
  // request lands at Caddy's apex catch-all (the console) → 404. The
  // scope option pins the SW to the prefix too — without it Chrome
  // would refuse to register a SW whose script path is more specific
  // than the page's directory.
  const swPath = url('/sw.js');
  // `scope` must end with `/` and be no more specific than the script
  // path. `${basePath}/` works in both modes — single-app: `/`; multi-
  // app: `/connect/`.
  const swScope = url('/');
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(swPath, { scope: swScope }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('sw registration failed', err);
    });
  });
}

export function useAddToHomeScreen(): {
  available: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
} {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    function onBeforeInstall(e: Event): void {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);
  async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!evt) return 'unavailable';
    await evt.prompt();
    const choice = await evt.userChoice;
    setEvt(null);
    return choice.outcome;
  }
  return { available: Boolean(evt), promptInstall };
}
