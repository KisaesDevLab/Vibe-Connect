// Runs the rewrap-for-new-devices sweep on:
//   * mount (once per unlocked session)
//   * every socket (re)connect
//   * every `device:enrolled` push
//   * a 60s periodic ticker, in case we miss a push entirely
// Renders nothing. Lives inside RealtimeProvider + CryptoProvider so it has
// access to both.
import { useEffect, useRef } from 'react';
import { useCrypto } from '../state/crypto.js';
import { useRealtime } from '../state/realtime.js';
import { runDeviceRewrapSweep } from '../state/rewrap.js';

export function DeviceSyncRunner(): null {
  const { getSecretKey, device, recipientId, isLocked } = useCrypto();
  const { connectionStatus, socket } = useRealtime();
  const hasSweptOnceRef = useRef(false);

  async function sweep(reason: string): Promise<void> {
    if (isLocked || !device) {
      // eslint-disable-next-line no-console
      console.debug('device-sync: skipped', { reason, why: 'locked or no device' });
      return;
    }
    const rid = recipientId();
    const sec = getSecretKey();
    if (!rid || !sec) {
      // eslint-disable-next-line no-console
      console.debug('device-sync: skipped', { reason, why: 'no rid/secret yet' });
      return;
    }
    try {
      const crypto = await import('@vibe-connect/crypto');
      const result = await runDeviceRewrapSweep({
        crypto,
        myRecipientId: rid,
        myDevicePublicKey: device.publicKey,
        myDeviceSecretKey: sec,
      });
      // eslint-disable-next-line no-console
      console.info('device-sync: sweep', { reason, ...result });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('device-sync: sweep failed', { reason, err });
    }
  }

  // Kick a sweep on every connect — first time AND reconnects. We lean on the
  // internal rate-limit inside runDeviceRewrapSweep (15s min interval) to
  // prevent accidental storms.
  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    if (isLocked || !device) return;
    const rid = recipientId();
    const sec = getSecretKey();
    if (!rid || !sec) return;
    const reason = hasSweptOnceRef.current ? 'reconnect' : 'mount';
    hasSweptOnceRef.current = true;
    const t = window.setTimeout(() => {
      void sweep(reason);
    }, 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus, device, isLocked, getSecretKey, recipientId]);

  // React to push events from the server when any staff user enrolls a device.
  useEffect(() => {
    if (!socket) return;
    const handler = (evt: { userId?: string; deviceId?: string }): void => {
      // eslint-disable-next-line no-console
      console.info('device-sync: received device:enrolled', evt);
      void sweep('device:enrolled');
    };
    socket.on('device:enrolled', handler);
    return () => {
      socket.off('device:enrolled', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, device, isLocked, getSecretKey, recipientId]);

  // v0.4.35 — react to client portal logins so the conversation key gets
  // wrapped for the new session's public key immediately (instead of on
  // the next 60s periodic sweep tick). The portal side renders
  // "Waiting for your firm…" while this is pending; getting the sweep
  // to run fast keeps that wait sub-second when any staff is online.
  useEffect(() => {
    if (!socket) return;
    const handler = (evt: { externalIdentityId?: string; sessionId?: string }): void => {
      // eslint-disable-next-line no-console
      console.info('device-sync: received client:session_created', evt);
      void sweep('client:session_created');
    };
    socket.on('client:session_created', handler);
    return () => {
      socket.off('client:session_created', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, device, isLocked, getSecretKey, recipientId]);

  // Belt-and-braces: periodic sweep so a missed realtime push still converges.
  // Piggy-backs on runDeviceRewrapSweep's rate-limit for coalescing.
  useEffect(() => {
    if (isLocked || !device) return;
    const iv = window.setInterval(() => {
      void sweep('periodic');
    }, 60_000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, isLocked, getSecretKey, recipientId]);

  return null;
}
