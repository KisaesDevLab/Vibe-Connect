/**
 * useCrypto — browser-side E2EE primitives bound to the current user/device.
 *
 * CRYPTO: private-key material is loaded once per session and held in memory. Wrapped keys
 * come from the server; plaintext only ever exists inside React hooks/components.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DecryptedMessage, EncryptedMessage } from '@vibe-connect/shared-types';
// Types only — value access is dynamically imported below so libsodium (~986 KB)
// doesn't ship in the first-paint bundle of /login or /setup.
import type * as CryptoModule from '@vibe-connect/crypto';
import { api } from '../api.js';
import { useAuth } from './auth.js';

let cryptoPromise: Promise<typeof CryptoModule> | null = null;
function loadCrypto(): Promise<typeof CryptoModule> {
  if (!cryptoPromise) cryptoPromise = import('@vibe-connect/crypto');
  return cryptoPromise;
}

interface DeviceRecord {
  deviceId: string;
  publicKey: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
  kdfParams: { opsLimit: number; memLimit: number; algorithm: 'argon2id13' };
  createdAt: string;
}

/** Persisted per-user device record, stored in IndexedDB for cross-tab reuse. */
const IDB_NAME = 'vibe-connect-device';
const IDB_STORE = 'keys';
const IDB_VERSION = 1;

async function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value as unknown as object, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Irreversibly removes the caller's locally-stored device record. The wrapped
 * private key cannot be reconstructed from the server, so after this the device
 * must re-enroll (new device_id + keypair) to read future messages.
 */
export async function wipeDeviceSecrets(userId: string): Promise<void> {
  await idbDel(`device:${userId}`);
  try {
    window.sessionStorage.removeItem(sessionKeyName(userId));
  } catch {
    /* sessionStorage may be blocked in exotic contexts */
  }
}

/**
 * Key name under which we cache the *unwrapped* device secret key in sessionStorage.
 * sessionStorage is scoped to the browser tab — survives refresh, wiped on tab close
 * and explicitly by logout/lock/revoke. This is the narrow compromise that lets the
 * user refresh without re-typing the device passphrase while keeping the unwrapped
 * key out of any long-lived storage (no localStorage, no IDB for the plaintext).
 *
 * CRYPTO: the UNWRAPPED secret is the bytes an attacker needs to read conversations.
 * It lives in (a) the React ref during normal use and (b) sessionStorage to survive
 * refresh. CSP restricts script-src to 'self' + 'wasm-unsafe-eval' so XSS has no
 * surface. Admin idle-lock fires immediately clear both copies.
 */
function sessionKeyName(userId: string): string {
  return `vibe:device-key:${userId}`;
}

interface CryptoCtx {
  ready: boolean;
  hasDevice: boolean;
  /** Create or load the device keypair for the currently logged-in user. */
  enroll: (password: string) => Promise<void>;
  /** Unlock an existing device with the user's password. Stores the secret key in memory. */
  unlock: (password: string) => Promise<boolean>;
  /**
   * Decrypt an encrypted message using this device's wrapped conversation key.
   * `wrappedKeysByVersion` maps rotation_version → wrappedKeys map. The fall-
   * back `wrappedKeys` (latest) is still accepted for backward compatibility
   * with callers that haven't been updated; new code should always pass
   * `wrappedKeysByVersion` so messages from prior rotations still decrypt.
   */
  decrypt: (
    message: EncryptedMessage,
    wrappedKeys: Record<string, string> | null,
    recipientId: string | null,
    wrappedKeysByVersion?: Record<string, Record<string, string>> | null,
  ) => Promise<DecryptedMessage>;
  /** Encrypt + upload a plaintext body using the current conversation key (caller supplies). */
  encryptForConversation: (
    plaintext: string,
    conversationKey: Uint8Array,
    contentKeyVersion: number,
  ) => Promise<{ ciphertext: string }>;
  /** Build a new conversation key wrapped to a list of device public keys + the firm key. */
  buildConversationKey: (
    recipients: { id: string; publicKey: string }[],
  ) => Promise<{ key: Uint8Array; wrappedKeys: Record<string, string>; rotationVersion: number }>;
  /** The current user's device record (public half). */
  device: DeviceRecord | null;
  /**
   * Returns the unwrapped (in-memory) device secret key, or null if locked.
   * Callers use this to unwrap conversation keys for per-message crypto. The value
   * lives in a React ref and is wiped by `wipeDeviceSecrets`.
   */
  getSecretKey: () => string | null;
  /**
   * Stable identifier used to key wrapped conversation keys in `conversation_keys.wrapped_keys`.
   * Format: `${userId}:${deviceId}`. Matches the shape Sidebar uses when wrapping.
   */
  recipientId: () => string | null;
  /** True when the device is enrolled but currently locked (no secret key in memory). */
  isLocked: boolean;
  /** Force the device into the locked state without waiting for the idle timer. */
  lock: () => void;
  /** True after the IDB device-record lookup has resolved (even if empty). */
  deviceChecked: boolean;
  /** Active idle-lock threshold in milliseconds (0 = disabled). Exposed so the
   *  lock overlay can render the real value instead of a hardcoded message. */
  idleLockMs: number;
}

// Default idle-lock timeout if the firm policy hasn't been fetched yet. CPA firms
// typically require workstation auto-lock under IRS Pub 4557; this is the app-layer
// equivalent. Admins override via Admin → Settings (0 = never auto-lock).
const DEFAULT_IDLE_LOCK_MS = 15 * 60 * 1000;

const Ctx = createContext<CryptoCtx | null>(null);

export function CryptoProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  // deviceChecked becomes true after the IDB lookup completes, regardless of whether
  // a record was found. Lets downstream components (Protected, LockOverlay) wait for
  // the final answer instead of reacting to the transient "null during IDB read".
  const [deviceChecked, setDeviceChecked] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [idleLockMs, setIdleLockMs] = useState<number>(DEFAULT_IDLE_LOCK_MS);
  const secretKeyRef = useRef<string | null>(null);

  // Fetch the firm-wide security policy once the user is authenticated. 0 = disabled.
  useEffect(() => {
    if (!user) {
      setIdleLockMs(DEFAULT_IDLE_LOCK_MS);
      return;
    }
    let cancelled = false;
    void api.getSecurityPolicy().then((p) => {
      if (cancelled) return;
      const mins = Math.max(0, Math.min(1440, p.idleLockMinutes));
      setIdleLockMs(mins === 0 ? 0 : mins * 60_000);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const lock = useCallback(() => {
    secretKeyRef.current = null;
    if (user) {
      try {
        window.sessionStorage.removeItem(sessionKeyName(user.id));
      } catch {
        /* best effort */
      }
    }
    if (device) setIsLocked(true);
  }, [device, user]);

  // Idle-timer-based auto-lock. Reset on any user activity; fire on expiry.
  // idleLockMs === 0 disables the timer per firm policy.
  useEffect(() => {
    if (!device || !secretKeyRef.current || isLocked) return;
    if (idleLockMs <= 0) return;
    let timer = window.setTimeout(lock, idleLockMs);
    function onActivity(): void {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, idleLockMs);
    }
    const events: (keyof WindowEventMap)[] = [
      'mousedown',
      'keydown',
      'scroll',
      'touchstart',
      'focus',
    ];
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, onActivity);
    };
  }, [device, isLocked, lock, idleLockMs]);

  // Lazy-load the crypto module + libsodium only once we actually need it.
  // Login and install pages never reach a path that calls `loadCrypto()`, so
  // libsodium (~986 KB) never ships in their first paint.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const c = await loadCrypto();
      await c.ready();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Load persisted device record + cached unwrapped secret key once the user is known.
  useEffect(() => {
    if (!user) {
      setDevice(null);
      setIsLocked(false);
      setDeviceChecked(false);
      secretKeyRef.current = null;
      return;
    }
    setDeviceChecked(false);
    void (async () => {
      const rec = await idbGet<DeviceRecord>(`device:${user.id}`);
      if (rec) {
        setDevice(rec);
        // Restore the unwrapped key from sessionStorage if present. sessionStorage
        // is tab-scoped and wiped on tab close, so this survives refresh within the
        // same tab without putting plaintext in any long-lived storage.
        try {
          const cached = window.sessionStorage.getItem(sessionKeyName(user.id));
          if (cached) {
            secretKeyRef.current = cached;
            setIsLocked(false);
          } else if (!secretKeyRef.current) {
            setIsLocked(true);
          }
        } catch {
          if (!secretKeyRef.current) setIsLocked(true);
        }
      }
      setDeviceChecked(true);
    })();
  }, [user]);

  const enroll = useCallback(
    async (password: string) => {
      if (!user) throw new Error('not logged in');
      const c = await loadCrypto();
      const enrolled = await c.enrollDevice({
        password,
        deviceId: c.newDeviceId(),
        clientPlatform: 'pwa',
        clientVersion: '0.1.0',
      });
      const record: DeviceRecord = {
        deviceId: enrolled.deviceId,
        publicKey: enrolled.publicKey,
        encryptedPrivateKey: enrolled.encryptedPrivateKey,
        kdfSalt: enrolled.kdfSalt,
        kdfParams: enrolled.kdfParams,
        createdAt: new Date().toISOString(),
      };
      await idbSet(`device:${user.id}`, record);
      setDevice(record);
      const secret = await c.unlockDevicePrivateKey(enrolled, password);
      secretKeyRef.current = secret;
      try {
        window.sessionStorage.setItem(sessionKeyName(user.id), secret);
      } catch {
        /* sessionStorage may be unavailable in private browsing quota-exceeded */
      }
      await api.enrollDevice({
        deviceId: enrolled.deviceId,
        publicKey: enrolled.publicKey,
        encryptedPrivateKey: enrolled.encryptedPrivateKey,
        kdfSalt: enrolled.kdfSalt,
        kdfParams: enrolled.kdfParams,
        clientPlatform: enrolled.clientPlatform,
        clientVersion: enrolled.clientVersion,
      });
    },
    [user],
  );

  const unlock = useCallback(
    async (password: string) => {
      if (!device) return false;
      try {
        const c = await loadCrypto();
        const secret = await c.unlockDevicePrivateKey(
          {
            encryptedPrivateKey: device.encryptedPrivateKey,
            kdfSalt: device.kdfSalt,
            kdfParams: device.kdfParams,
          },
          password,
        );
        secretKeyRef.current = secret;
        if (user) {
          try {
            window.sessionStorage.setItem(sessionKeyName(user.id), secret);
          } catch {
            /* best effort */
          }
        }
        setIsLocked(false);
        return true;
      } catch {
        return false;
      }
    },
    [device, user],
  );

  const decrypt = useCallback<CryptoCtx['decrypt']>(
    async (message, wrappedKeys, recipientId, wrappedKeysByVersion) => {
      if (!device || !secretKeyRef.current || !recipientId) {
        throw new Error('device not unlocked');
      }
      // Pick the wrapped_keys map matching this message's rotation version.
      // Fall back to the legacy single `wrappedKeys` parameter so old call
      // sites keep working until they're updated.
      const versionKey = String(message.contentKeyVersion);
      const forThisVersion =
        wrappedKeysByVersion && wrappedKeysByVersion[versionKey]
          ? wrappedKeysByVersion[versionKey]
          : wrappedKeys;
      if (!forThisVersion) {
        throw new Error('no wrapped_keys available for this message version');
      }
      // Phase 24: system-source messages (revision-requested, nudge-sent,
      // future request-item-done announcements) carry empty ciphertext and
      // render from ciphertextMeta instead. The decrypt path would otherwise
      // throw on `JSON.parse(atob(""))` and surface a confusing
      // "(unable to decrypt)" bubble. Branch early and produce a cleartext
      // body the UI can style as a system event.
      if (message.source === 'system') {
        const meta = (message.ciphertextMeta ?? {}) as Record<string, unknown>;
        const eventType = String(meta.systemEventType ?? '');
        let body = '';
        if (eventType === 'request_item_revision') {
          body = '🔁 Revision requested. See the Requests panel for the note.';
        } else if (eventType === 'request_nudge_sent') {
          const listTitle =
            typeof meta.listTitle === 'string' ? meta.listTitle : 'pending items';
          const custom = typeof meta.customBody === 'string' ? meta.customBody : null;
          body = custom
            ? `🔔 Reminder: ${custom}`
            : `🔔 Reminder — items still needed in ${listTitle}.`;
        } else if (eventType === 'request_item_done') {
          body = '✅ Item marked done.';
        } else if (eventType === 'request_list_created') {
          body = '📝 New request list created.';
        } else {
          body = '⚙ System event';
        }
        return {
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          senderExternalIdentityId: message.senderExternalIdentityId,
          body,
          urgent: message.urgent,
          scheduledFor: message.scheduledFor,
          source: message.source,
          createdAt: message.createdAt,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          attachments: [],
        };
      }
      // Bridge-sealed messages (email-in / sms-in) are wrapped to the firm public key,
      // not the conversation key. They stay unreadable on staff devices until an admin
      // "rewraps" them under the conversation key (future phase). Surface them with a
      // placeholder body + a distinct `bridge-pending` marker the UI can style.
      const meta = message.ciphertextMeta as
        | { bridgePending?: boolean; algorithm?: string }
        | null
        | undefined;
      if (
        message.contentKeyVersion === 0 &&
        meta?.bridgePending &&
        (message.source === 'email-in' || message.source === 'sms-in')
      ) {
        return {
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          senderExternalIdentityId: message.senderExternalIdentityId,
          body:
            message.source === 'email-in'
              ? '[bridged email — awaiting rewrap by an admin]'
              : '[bridged SMS — awaiting rewrap by an admin]',
          urgent: message.urgent,
          scheduledFor: message.scheduledFor,
          source: message.source,
          createdAt: message.createdAt,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          attachments: [],
        };
      }
      const c = await loadCrypto();
      const conversationKey = await c.unwrapConversationKey(
        forThisVersion,
        recipientId,
        device.publicKey,
        secretKeyRef.current,
      );
      const envelope = JSON.parse(atob(message.ciphertext)) as CryptoModule.SymmetricEnvelope;
      const plain = await c.decryptMessage(envelope, conversationKey);
      const attachments = await Promise.all(
        message.attachments.map(async (a) => {
          let filename = '';
          try {
            filename = c.utf8Decode(
              await c.secretboxDecrypt(a.filenameCiphertext, conversationKey),
            );
          } catch {
            filename = '(encrypted)';
          }
          return {
            id: a.id,
            filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            wrappedFileKey: a.wrappedFileKey,
            contentKeyVersion: message.contentKeyVersion,
            scanStatus: (a.scanStatus ?? 'clean') as 'pending' | 'clean' | 'infected',
          };
        }),
      );
      return {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        senderExternalIdentityId: message.senderExternalIdentityId,
        body: c.utf8Decode(plain),
        urgent: message.urgent,
        scheduledFor: message.scheduledFor,
        source: message.source,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
        attachments,
      };
    },
    [device],
  );

  const encryptForConversation = useCallback<CryptoCtx['encryptForConversation']>(
    async (plaintext, conversationKey, contentKeyVersion) => {
      const c = await loadCrypto();
      const env = await c.encryptMessage(
        c.utf8Encode(plaintext),
        conversationKey,
        contentKeyVersion,
      );
      return { ciphertext: btoa(JSON.stringify(env)) };
    },
    [],
  );

  const buildConversationKey = useCallback<CryptoCtx['buildConversationKey']>(
    async (recipients) => {
      const c = await loadCrypto();
      const { bundle, wrappedKeys } = await c.createConversationKey(recipients);
      return { key: bundle.key, wrappedKeys, rotationVersion: bundle.rotationVersion };
    },
    [],
  );

  const getSecretKey = useCallback(() => secretKeyRef.current, []);
  const recipientId = useCallback(
    () => (user && device ? `${user.id}:${device.deviceId}` : null),
    [user, device],
  );

  const value = useMemo<CryptoCtx>(
    () => ({
      ready,
      hasDevice: Boolean(device),
      enroll,
      unlock,
      decrypt,
      encryptForConversation,
      buildConversationKey,
      device,
      getSecretKey,
      recipientId,
      isLocked,
      lock,
      deviceChecked,
      idleLockMs,
    }),
    [
      ready,
      device,
      enroll,
      unlock,
      decrypt,
      encryptForConversation,
      buildConversationKey,
      getSecretKey,
      recipientId,
      isLocked,
      lock,
      deviceChecked,
      idleLockMs,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCrypto(): CryptoCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('CryptoProvider missing');
  return v;
}
