// XChaCha20-Poly1305 symmetric encryption for message and attachment bodies.
// CRYPTO: the single path for at-rest encryption of user content.
import { ready } from './sodium.js';
import { concat, fromBase64, toBase64 } from './encoding.js';

/** The on-the-wire envelope for an encrypted message. */
export interface SymmetricEnvelope {
  n: string; // nonce, base64 (24 bytes)
  c: string; // ciphertext+tag, base64
  v: number; // content key version
}

export async function generateSymmetricKey(): Promise<Uint8Array> {
  const s = await ready();
  return s.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export async function encryptMessage(
  plaintext: Uint8Array,
  key: Uint8Array,
  version: number,
  associatedData?: Uint8Array,
): Promise<SymmetricEnvelope> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData ?? null,
    null,
    nonce,
    key,
  );
  return { n: toBase64(nonce), c: toBase64(ct), v: version };
}

export async function decryptMessage(
  envelope: SymmetricEnvelope,
  key: Uint8Array,
  associatedData?: Uint8Array,
): Promise<Uint8Array> {
  const s = await ready();
  const nonce = fromBase64(envelope.n);
  const ct = fromBase64(envelope.c);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, associatedData ?? null, nonce, key);
}

/** Encrypt an arbitrary blob with a fresh random key. Returns the wrapped envelope and the key. */
export async function encryptWithFreshKey(
  plaintext: Uint8Array,
): Promise<{ key: Uint8Array; envelope: SymmetricEnvelope }> {
  const key = await generateSymmetricKey();
  const envelope = await encryptMessage(plaintext, key, 1);
  return { key, envelope };
}

/** Secretbox variant used for wrapping private keys with a password-derived key. */
export async function secretboxEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<string> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ct = s.crypto_secretbox_easy(plaintext, nonce, key);
  return toBase64(concat(nonce, ct));
}

export async function secretboxDecrypt(blob: string, key: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const raw = fromBase64(blob);
  const nonce = raw.subarray(0, s.crypto_secretbox_NONCEBYTES);
  const ct = raw.subarray(s.crypto_secretbox_NONCEBYTES);
  return s.crypto_secretbox_open_easy(ct, nonce, key);
}
