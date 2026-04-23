// Service worker registration + "Add to home screen" prompt tracker.
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
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
