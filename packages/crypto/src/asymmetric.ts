// X25519 keypairs and sealed-box / box wrapping for per-recipient key delivery.
// CRYPTO: conversation keys are wrapped per device/session using these primitives.
import { ready } from './sodium.js';
import { fromBase64, toBase64 } from './encoding.js';

export interface KeyPair {
  publicKey: string; // base64
  secretKey: string; // base64
}

export async function generateKeypair(): Promise<KeyPair> {
  const s = await ready();
  const kp = s.crypto_box_keypair();
  return { publicKey: toBase64(kp.publicKey), secretKey: toBase64(kp.privateKey) };
}

/**
 * Wrap a symmetric key for a single recipient (X25519 public key). Anonymous sealed box:
 * recipient needs only their private key to decrypt; sender is not authenticated (we don't
 * need authentication here — the conversation key is just being delivered).
 */
export async function wrapKey(
  symmetricKey: Uint8Array,
  recipientPublicKey: string,
): Promise<string> {
  const s = await ready();
  const pub = fromBase64(recipientPublicKey);
  const sealed = s.crypto_box_seal(symmetricKey, pub);
  return toBase64(sealed);
}

export async function unwrapKey(
  wrapped: string,
  recipientPublicKey: string,
  recipientSecretKey: string,
): Promise<Uint8Array> {
  const s = await ready();
  const pub = fromBase64(recipientPublicKey);
  const sec = fromBase64(recipientSecretKey);
  const ct = fromBase64(wrapped);
  return s.crypto_box_seal_open(ct, pub, sec);
}
