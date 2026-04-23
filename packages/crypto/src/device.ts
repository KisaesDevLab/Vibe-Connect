// Per-device staff key enrollment. The private key is wrapped with an Argon2id-derived key from
// the user's password, so the server never sees the unwrapped form.
// CRYPTO: the sole path for enrolling a new workstation + PWA + desktop install.
import { generateKeypair } from './asymmetric.js';
import { fromBase64, toBase64 } from './encoding.js';
import { deriveKeyFromPassword, DEFAULT_KDF_MEM, DEFAULT_KDF_OPS, randomSalt } from './kdf.js';
import { secretboxDecrypt, secretboxEncrypt } from './symmetric.js';

export interface DeviceEnrollmentInput {
  password: string;
  deviceId: string;
  clientPlatform: 'tauri-win' | 'tauri-mac' | 'tauri-linux' | 'pwa' | 'web';
  clientVersion: string;
}

export interface DeviceEnrollmentResult {
  publicKey: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
  kdfParams: { opsLimit: number; memLimit: number; algorithm: 'argon2id13' };
  deviceId: string;
  clientPlatform: DeviceEnrollmentInput['clientPlatform'];
  clientVersion: string;
}

export async function enrollDevice(input: DeviceEnrollmentInput): Promise<DeviceEnrollmentResult> {
  const salt = await randomSalt();
  const wrappingKey = await deriveKeyFromPassword(input.password, salt);
  const { publicKey, secretKey } = await generateKeypair();
  const wrapped = await secretboxEncrypt(fromBase64(secretKey), wrappingKey);
  return {
    publicKey,
    encryptedPrivateKey: wrapped,
    kdfSalt: toBase64(salt),
    kdfParams: { opsLimit: DEFAULT_KDF_OPS, memLimit: DEFAULT_KDF_MEM, algorithm: 'argon2id13' },
    deviceId: input.deviceId,
    clientPlatform: input.clientPlatform,
    clientVersion: input.clientVersion,
  };
}

export async function unlockDevicePrivateKey(
  record: Pick<DeviceEnrollmentResult, 'encryptedPrivateKey' | 'kdfSalt' | 'kdfParams'>,
  password: string,
): Promise<string> {
  const salt = fromBase64(record.kdfSalt);
  const wrappingKey = await deriveKeyFromPassword(password, salt, record.kdfParams);
  const raw = await secretboxDecrypt(record.encryptedPrivateKey, wrappingKey);
  return toBase64(raw);
}

/**
 * Generates a stable device id that survives reinstalls of the same browser on the same
 * machine as long as IndexedDB persists. Callers must persist the result.
 */
export function newDeviceId(): string {
  // 16 bytes of randomness, hex-encoded = 32 chars; matches the 128-char column size.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node path used in tests; libsodium is already loaded by the time this runs in prod.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const nodeCrypto = require('node:crypto');
    const buf = nodeCrypto.randomBytes(16);
    bytes.set(buf);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
