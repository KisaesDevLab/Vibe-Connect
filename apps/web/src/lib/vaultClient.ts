// Phase 26 — browser-side Client Vault helpers.
//
// Wraps the libsodium primitives in @vibe-connect/crypto and the tus 1.0.0
// protocol into the small surface the ClientFiles page actually needs:
//
//   unwrapZoneKey       — decrypt the wrapped zone key with the user's device key
//   encryptVaultFile    — generate per-file key, encrypt body + filename, wrap key
//   decryptVaultFile    — reverse of the above for downloads
//   tusUploadCiphertext — minimal browser tus client: POST then PATCH-to-completion
//
// CRYPTO: the per-file XChaCha20-Poly1305 key never leaves this module —
// generated, used to encrypt, then immediately re-wrapped under the zone
// key for transit. Plaintext file bytes only exist transiently inside an
// ArrayBuffer that the GC reclaims after upload completes.

// Types only — value access is dynamic to avoid pulling libsodium into the
// first-paint bundle.
import type * as CryptoModule from '@vibe-connect/crypto';

let cryptoPromise: Promise<typeof CryptoModule> | null = null;
function loadCrypto(): Promise<typeof CryptoModule> {
  if (!cryptoPromise) cryptoPromise = import('@vibe-connect/crypto');
  return cryptoPromise;
}

export async function unwrapZoneKey(
  wrappedKeys: Record<string, string>,
  recipientId: string,
  devicePublicKey: string,
  deviceSecretKey: string,
): Promise<Uint8Array> {
  const c = await loadCrypto();
  const wrapped = wrappedKeys[recipientId];
  if (!wrapped) throw new Error('no wrapped key for this recipient');
  return c.unwrapKey(wrapped, devicePublicKey, deviceSecretKey);
}

export interface EncryptedVaultFile {
  ciphertext: Uint8Array; // file bytes encrypted with the per-file key
  filenameCiphertext: string; // base64 (secretbox under zone key)
  wrappedFileKey: string; // base64 (secretbox of per-file key under zone key)
  contentKeyVersion: number;
}

export async function encryptVaultFile(
  filename: string,
  fileBuffer: ArrayBuffer,
  zoneKey: Uint8Array,
  contentKeyVersion: number,
): Promise<EncryptedVaultFile> {
  const c = await loadCrypto();
  // Per-file symmetric key.
  const fileKey = await c.generateSymmetricKey();
  // Encrypt file body.
  const env = await c.encryptMessage(new Uint8Array(fileBuffer), fileKey, contentKeyVersion);
  const ciphertext = c.utf8Encode(JSON.stringify(env));
  // Wrap per-file key under zone key (libsodium secretbox; symmetric).
  const wrappedFileKey = await c.secretboxEncrypt(fileKey, zoneKey);
  // Encrypt filename under zone key (same envelope shape as message attachments).
  const filenameCiphertext = await c.secretboxEncrypt(c.utf8Encode(filename), zoneKey);
  return {
    ciphertext,
    filenameCiphertext,
    wrappedFileKey,
    contentKeyVersion,
  };
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

// Encrypt a folder/file name under the zone key. Returned base64 string
// goes straight into vault_folders.name_ciphertext / vault_files.filename_ciphertext
// (or the tus Upload-Metadata `filenameCiphertext` field).
export async function encryptVaultName(name: string, zoneKey: Uint8Array): Promise<string> {
  const c = await loadCrypto();
  return c.secretboxEncrypt(c.utf8Encode(name), zoneKey);
}

// Generate a fresh symmetric zone key and wrap it to every recipient.
// Server stores the wrapped map under (vault_id, zone, rotationVersion=1).
// Returns the unwrapped key so the caller can immediately encrypt folder
// names + files without a round-trip.
export async function seedZoneKey(
  recipients: { id: string; publicKey: string }[],
): Promise<{ key: Uint8Array; wrappedKeys: Record<string, string> }> {
  const c = await loadCrypto();
  const { bundle, wrappedKeys } = await c.createConversationKey(recipients);
  return { key: bundle.key, wrappedKeys };
}

// ---------- Browser tus 1.0.0 client ----------
//
// Two-step protocol:
//   POST  uploadInitUrl     → returns Location header pointing at upload-id endpoint
//   PATCH location          → streams ciphertext bytes; offset advances per chunk
//
// We chunk in 5 MiB blocks so a network drop doesn't lose the entire upload.
// On error, we HEAD the upload-id to learn the server-confirmed offset and
// resume. Caller passes a progress callback (bytes uploaded / total).

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
  signal?: AbortSignal;
}

export interface TusUploadResult {
  uploadUrl: string;
  bytesUploaded: number;
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
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`tus_create_failed_${res.status}`);
  const location = res.headers.get('Location');
  if (!location) throw new Error('tus_create_missing_location');
  return location;
}

async function tusHead(uploadUrl: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(uploadUrl, {
    method: 'HEAD',
    credentials: 'include',
    headers: { 'Tus-Resumable': TUS_VERSION },
    signal,
  });
  if (!res.ok) throw new Error(`tus_head_failed_${res.status}`);
  const offset = Number(res.headers.get('Upload-Offset') ?? '0');
  return offset;
}

async function tusPatch(
  uploadUrl: string,
  buffer: Uint8Array,
  offset: number,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(uploadUrl, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
    },
    // Type the BodyInit to satisfy fetch — BufferSource is the intended shape
    // for binary uploads.
    body: buffer as BodyInit,
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw Object.assign(new Error(`tus_patch_failed_${res.status}`), {
      status: res.status,
      detail,
    });
  }
  return Number(res.headers.get('Upload-Offset') ?? '0');
}

export async function tusUploadCiphertext(opts: TusUploadOptions): Promise<TusUploadResult> {
  const uploadUrl = await tusCreate(opts);
  let offset = 0;
  const total = opts.ciphertext.length;
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = opts.ciphertext.subarray(offset, end);
    try {
      offset = await tusPatch(uploadUrl, chunk, offset, opts.signal);
    } catch (err) {
      // On a transient failure, ask the server where it actually is and
      // resume from there. If HEAD also fails, surface the original error.
      try {
        offset = await tusHead(uploadUrl, opts.signal);
        if (offset >= total) break; // server already finalized
        continue;
      } catch {
        throw err;
      }
    }
    opts.onProgress?.(offset, total);
  }
  return { uploadUrl, bytesUploaded: offset };
}
