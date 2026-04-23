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
import * as crypto from '@vibe-connect/crypto';
import { useAuth } from './auth.js';

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

interface CryptoCtx {
  ready: boolean;
  hasDevice: boolean;
  /** Create or load the device keypair for the currently logged-in user. */
  enroll: (password: string) => Promise<void>;
  /** Unlock an existing device with the user's password. Stores the secret key in memory. */
  unlock: (password: string) => Promise<boolean>;
  /** Decrypt an encrypted message using this device's wrapped conversation key. */
  decrypt: (
    message: EncryptedMessage,
    wrappedKeys: Record<string, string> | null,
    recipientId: string | null,
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
}

const Ctx = createContext<CryptoCtx | null>(null);

export function CryptoProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const secretKeyRef = useRef<string | null>(null);

  // One-shot libsodium load.
  useEffect(() => {
    void crypto.ready().then(() => setReady(true));
  }, []);

  // Load persisted device record once the user is known.
  useEffect(() => {
    if (!user) {
      setDevice(null);
      secretKeyRef.current = null;
      return;
    }
    void (async () => {
      const rec = await idbGet<DeviceRecord>(`device:${user.id}`);
      if (rec) setDevice(rec);
    })();
  }, [user]);

  const enroll = useCallback(
    async (password: string) => {
      if (!user) throw new Error('not logged in');
      const enrolled = await crypto.enrollDevice({
        password,
        deviceId: crypto.newDeviceId(),
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
      const secret = await crypto.unlockDevicePrivateKey(enrolled, password);
      secretKeyRef.current = secret;
      // TODO(phase3-backend-glue): POST to /users/me/devices with enrolled.publicKey +
      // encryptedPrivateKey + kdf params. Currently no server route. Phase 11 + 13 will
      // add it.
    },
    [user],
  );

  const unlock = useCallback(
    async (password: string) => {
      if (!device) return false;
      try {
        const secret = await crypto.unlockDevicePrivateKey(
          {
            encryptedPrivateKey: device.encryptedPrivateKey,
            kdfSalt: device.kdfSalt,
            kdfParams: device.kdfParams,
          },
          password,
        );
        secretKeyRef.current = secret;
        return true;
      } catch {
        return false;
      }
    },
    [device],
  );

  const decrypt = useCallback<CryptoCtx['decrypt']>(
    async (message, wrappedKeys, recipientId) => {
      if (!device || !secretKeyRef.current || !wrappedKeys || !recipientId) {
        throw new Error('device not unlocked');
      }
      const conversationKey = await crypto.unwrapConversationKey(
        wrappedKeys,
        recipientId,
        device.publicKey,
        secretKeyRef.current,
      );
      const envelope = JSON.parse(atob(message.ciphertext)) as crypto.SymmetricEnvelope;
      const plain = await crypto.decryptMessage(envelope, conversationKey);
      return {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        senderExternalIdentityId: message.senderExternalIdentityId,
        body: crypto.utf8Decode(plain),
        urgent: message.urgent,
        scheduledFor: message.scheduledFor,
        source: message.source,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
        attachments: message.attachments.map((a) => ({
          id: a.id,
          filename: '',
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })),
      };
    },
    [device],
  );

  const encryptForConversation = useCallback<CryptoCtx['encryptForConversation']>(
    async (plaintext, conversationKey, contentKeyVersion) => {
      const env = await crypto.encryptMessage(
        crypto.utf8Encode(plaintext),
        conversationKey,
        contentKeyVersion,
      );
      return { ciphertext: btoa(JSON.stringify(env)) };
    },
    [],
  );

  const buildConversationKey = useCallback<CryptoCtx['buildConversationKey']>(
    async (recipients) => {
      const { bundle, wrappedKeys } = await crypto.createConversationKey(recipients);
      return { key: bundle.key, wrappedKeys, rotationVersion: bundle.rotationVersion };
    },
    [],
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
    }),
    [ready, device, enroll, unlock, decrypt, encryptForConversation, buildConversationKey],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCrypto(): CryptoCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('CryptoProvider missing');
  return v;
}
