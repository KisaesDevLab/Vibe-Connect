// Phase 26 — portal-side vault client. Shared zone only. The staff_only zone
// is invisible: no UI affordance, no count, no hint. The server's repository
// layer (vaultKeysRepo) refuses to deliver staff_only key bundles to a
// `client:*` recipient, so even if a malicious portal SPA tried to ask for
// one, the bytes never leave the server.
//
// Mirrors apps/web/src/lib/vaultClient.ts but trimmed to what the portal
// page actually uses: zone key unwrap, file/filename encrypt/decrypt, and
// a minimal browser tus 1.0.0 client.

import type * as CryptoModule from '@vibe-connect/crypto';

let cryptoPromise: Promise<typeof CryptoModule> | null = null;
function loadCrypto(): Promise<typeof CryptoModule> {
  if (!cryptoPromise) cryptoPromise = import('@vibe-connect/crypto');
  return cryptoPromise;
}

export async function unwrapZoneKey(
  wrappedKeys: Record<string, string>,
  sessionPublicKey: string,
  sessionSecretKey: string,
): Promise<Uint8Array | null> {
  // The portal session id is unknown to the page until /portal/me returns it.
  // We try every wrapped slot until one decrypts. Same pattern as
  // Conversations.tsx for conversation keys.
  const c = await loadCrypto();
  for (const wrapped of Object.values(wrappedKeys)) {
    try {
      return await c.unwrapKey(wrapped, sessionPublicKey, sessionSecretKey);
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface EncryptedVaultFile {
  ciphertext: Uint8Array;
  filenameCiphertext: string;
  wrappedFileKey: string;
  contentKeyVersion: number;
}

export async function encryptVaultFile(
  filename: string,
  fileBuffer: ArrayBuffer,
  zoneKey: Uint8Array,
  contentKeyVersion: number,
): Promise<EncryptedVaultFile> {
  const c = await loadCrypto();
  const fileKey = await c.generateSymmetricKey();
  const env = await c.encryptMessage(new Uint8Array(fileBuffer), fileKey, contentKeyVersion);
  const ciphertext = c.utf8Encode(JSON.stringify(env));
  const wrappedFileKey = await c.secretboxEncrypt(fileKey, zoneKey);
  const filenameCiphertext = await c.secretboxEncrypt(c.utf8Encode(filename), zoneKey);
  return { ciphertext, filenameCiphertext, wrappedFileKey, contentKeyVersion };
}

export async function decryptVaultFile(
  ciphertext: ArrayBuffer,
  wrappedFileKey: string,
  zoneKey: Uint8Array,
): Promise<Uint8Array> {
  const c = await loadCrypto();
  const fileKey = await c.secretboxDecrypt(wrappedFileKey, zoneKey);
  const envelope = JSON.parse(
    c.utf8Decode(new Uint8Array(ciphertext)),
  ) as CryptoModule.SymmetricEnvelope;
  return c.decryptMessage(envelope, fileKey);
}

export async function decryptVaultFilename(
  filenameCiphertext: string,
  zoneKey: Uint8Array,
): Promise<string> {
  const c = await loadCrypto();
  try {
    const plain = await c.secretboxDecrypt(filenameCiphertext, zoneKey);
    return c.utf8Decode(plain);
  } catch {
    return '(encrypted)';
  }
}

const TUS_VERSION = '1.0.0';
const CHUNK_SIZE = 5 * 1024 * 1024;

function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${btoa(v)}`)
    .join(',');
}

export interface TusUploadOptions {
  uploadInitUrl: string;
  ciphertext: Uint8Array;
  metadata: Record<string, string>;
  onProgress?: (bytes: number, total: number) => void;
}

async function tusCreate(opts: TusUploadOptions): Promise<string> {
  const res = await fetch(opts.uploadInitUrl, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(opts.ciphertext.length),
      'Upload-Metadata': encodeMetadata(opts.metadata),
    },
  });
  if (!res.ok) throw new Error(`tus_create_failed_${res.status}`);
  const location = res.headers.get('Location');
  if (!location) throw new Error('tus_create_missing_location');
  return location;
}

async function tusHead(url: string): Promise<number> {
  const res = await fetch(url, {
    method: 'HEAD',
    credentials: 'include',
    headers: { 'Tus-Resumable': TUS_VERSION },
  });
  if (!res.ok) throw new Error(`tus_head_failed_${res.status}`);
  return Number(res.headers.get('Upload-Offset') ?? '0');
}

async function tusPatch(url: string, buffer: Uint8Array, offset: number): Promise<number> {
  const res = await fetch(url, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    body: buffer as BodyInit,
  });
  if (!res.ok) throw new Error(`tus_patch_failed_${res.status}`);
  return Number(res.headers.get('Upload-Offset') ?? '0');
}

export async function tusUploadCiphertext(opts: TusUploadOptions): Promise<{ uploadUrl: string }> {
  const uploadUrl = await tusCreate(opts);
  let offset = 0;
  const total = opts.ciphertext.length;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = opts.ciphertext.subarray(offset, end);
    try {
      offset = await tusPatch(uploadUrl, chunk, offset);
    } catch (err) {
      try {
        offset = await tusHead(uploadUrl);
        if (offset >= total) break;
        continue;
      } catch {
        throw err;
      }
    }
    opts.onProgress?.(offset, total);
  }
  return { uploadUrl };
}
