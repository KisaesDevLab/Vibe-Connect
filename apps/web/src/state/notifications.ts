import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRealtime } from './realtime.js';
import { url } from '../lib/boot.js';

/** Tab title / favicon / unread-count coordinator. Pass the desired base
 *  title (e.g. the firm's admin-configured app name); the hook prefixes an
 *  unread badge when there's something to read. We don't latch on the
 *  initial document.title anymore — that broke when the admin changed the
 *  app name and the tab title kept showing the old value until reload. */
export function useTabBadge(unread: number, baseTitle?: string): void {
  useEffect(() => {
    const base = (baseTitle ?? '').trim() || 'Vibe Connect';
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
  }, [unread, baseTitle]);
}

/** Browser Notifications API + urgent-distinct sound. */
export function useDesktopNotifications(): {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  notify: (title: string, body: string, urgent?: boolean) => void;
} {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'denied' as NotificationPermission;
    const p = await Notification.requestPermission();
    setPermission(p);
    return p;
  }, []);
  const notify = useCallback(
    (title: string, body: string, urgent = false) => {
      if (typeof Notification === 'undefined' || permission !== 'granted') return;
      const n = new Notification(title, {
        body,
        icon: '/favicon.svg',
        tag: urgent ? 'vibe-urgent' : 'vibe-msg',
        requireInteraction: urgent,
      });
      if (urgent) playUrgentSound();
      n.onclick = () => {
        window.focus();
        n.close();
      };
    },
    [permission],
  );
  return { permission, requestPermission, notify };
}

function playUrgentSound(): void {
  try {
    const ctx = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'square';
    o.frequency.value = 880;
    g.gain.value = 0.12;
    o.start();
    setTimeout(() => (o.frequency.value = 660), 120);
    setTimeout(() => {
      o.stop();
      void ctx.close();
    }, 260);
  } catch {
    /* audio context may be blocked without a user gesture */
  }
}

/** Wire realtime events → desktop notifications. */
export function useRealtimeNotifications(): void {
  const { socket } = useRealtime();
  const { notify } = useDesktopNotifications();
  const qc = useQueryClient();
  useEffect(() => {
    if (!socket) return;
    function onNew(evt: { urgent: boolean; conversationId: string; senderId: string | null }) {
      if (document.hasFocus()) return;
      notify(evt.urgent ? 'Urgent message' : 'New message', 'Tap to open Vibe Connect', evt.urgent);
      qc.invalidateQueries({ queryKey: ['conversations'] });
    }
    // Phase 28.12 — anonymous intake landed. The server already targets
    // this event to the assigned staff's userId, so any socket holding
    // a session for that user receives it. We bump the admin-intake
    // sessions query to refresh the list + ring the standard desktop
    // notification (non-urgent) so a staff member with the staff app
    // in another tab sees the indicator.
    function onIntake(evt: { sessionId: string; fileCount: number }) {
      qc.invalidateQueries({ queryKey: ['admin', 'intake', 'sessions'] });
      if (document.hasFocus()) return;
      notify(
        'New intake',
        `${evt.fileCount} file${evt.fileCount === 1 ? '' : 's'} just submitted via the intake page.`,
        false,
      );
    }
    socket.on('message:new', onNew);
    socket.on('intake.session.received', onIntake);
    return () => {
      socket.off('message:new', onNew);
      socket.off('intake.session.received', onIntake);
    };
  }, [socket, notify, qc]);
}

/** Heartbeat ping so Admin → Device health shows this device as fresh. */
export async function postDeviceHeartbeat(
  deviceId: string,
  platform: 'tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web',
  version: string,
): Promise<void> {
  try {
    await fetch(url('/admin/devices/heartbeat'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, clientPlatform: platform, clientVersion: version }),
    });
  } catch {
    /* offline heartbeat is fine; the next one covers it */
  }
}

/**
 * PWA heartbeat hook. Fires once on mount and every 30 minutes while the tab is
 * focused, so staff devices don't slide into "stale" (>7d) under Admin → Device
 * health. Tauri shells should call `postDeviceHeartbeat` directly via their own
 * schedule instead of mounting this.
 *
 * Throttled so rapid alt-tab cycles don't flood /admin/devices/heartbeat — the
 * server truth doesn't change on a minute-to-minute basis for the "stale device"
 * flag, which only turns yellow after a week of silence.
 */
const CLIENT_VERSION = '0.1.0';
const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export function useDeviceHeartbeat(
  deviceId: string | null | undefined,
  platform: 'pwa' | 'web' = 'pwa',
): void {
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    let lastBeatAt = 0;
    const beat = (): void => {
      const now = Date.now();
      if (now - lastBeatAt < MIN_HEARTBEAT_INTERVAL_MS) return;
      lastBeatAt = now;
      void postDeviceHeartbeat(deviceId, platform, CLIENT_VERSION);
    };
    beat();
    const interval = window.setInterval(
      () => {
        if (cancelled) return;
        if (document.visibilityState === 'visible') beat();
      },
      30 * 60 * 1000,
    );
    function onVisible(): void {
      if (document.visibilityState === 'visible') beat();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [deviceId, platform]);
}

/** Register service worker + push subscription. */
export async function enablePush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  // Service worker scope must equal the SW's URL prefix. Under multi-app
  // (BASE_PATH=/connect) the SW lives at /connect/sw.js and only controls
  // /connect/* — exactly what we want so a sibling app's SW can't eat our
  // notifications.
  const reg = await navigator.serviceWorker.register(url('/sw.js'));
  const vapidRes = await fetch(url('/notifications/vapid-public-key'), { credentials: 'include' });
  const { publicKey } = (await vapidRes.json()) as { publicKey: string | null };
  if (!publicKey) return false;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  });
  const res = await fetch(url('/notifications/subscribe'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
  });
  return res.ok;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
