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

// -------- Streaming secretstream (XChaCha20-Poly1305) --------
//
// Phase 28.5 — Vibe File Transfer uses a streaming AEAD construction so a
// 50 MB intake upload can be encrypted-at-rest chunk-by-chunk without
// loading the whole plaintext (or the whole ciphertext) into RAM at once.
//
// The output format we settled on:
//
//   header (24 bytes)
//   [u32 BE length][ct chunk] (repeated)
//
// The header carries libsodium's stream salt; each ciphertext chunk carries
// its own 17-byte authenticator + a tag byte selected by the producer
// (MESSAGE on intermediate chunks, FINAL on the last one). The length
// prefix on every chunk lets the reader stay generic about producer chunk
// sizing — readers must NOT assume a fixed chunk size.
//
// CRYPTO: the FINAL tag is what guarantees nobody truncated the ciphertext.
// Readers that swallow a "no FINAL tag" stream as success leak truncation
// resilience the protocol was meant to guarantee — Phase 28.5's decrypt
// stream wrapper asserts this.

export interface StreamPushInit {
  /** 24-byte header. The caller writes this to the output BEFORE any
   *  ciphertext chunks; readers consume it before any pulls. */
  header: Uint8Array;
  /** Opaque per-stream state. Sodium docs guarantee it's an integer or
   *  small object — we treat it as a black box typed `unknown` so the
   *  underlying representation can change between libsodium versions
   *  without breaking the type contract. */
  state: unknown;
}

/** Initialise a push (encrypt) stream. Caller supplies the 32-byte key. */
export async function streamPushInit(key: Uint8Array): Promise<StreamPushInit> {
  const s = await ready();
  if (key.length !== s.crypto_secretstream_xchacha20poly1305_KEYBYTES) {
    throw new Error(
      `streamPushInit: key must be ${s.crypto_secretstream_xchacha20poly1305_KEYBYTES} bytes`,
    );
  }
  const r = s.crypto_secretstream_xchacha20poly1305_init_push(key);
  return { header: r.header, state: r.state };
}

/**
 * Encrypt one chunk. `final` MUST be true exactly once, on the last chunk,
 * so the reader can prove the stream wasn't truncated. The returned bytes
 * are the ciphertext + 17-byte tag; the caller is responsible for framing
 * (e.g. writing a length prefix before each chunk).
 */
export async function streamPush(
  state: unknown,
  chunk: Uint8Array,
  final: boolean,
): Promise<Uint8Array> {
  const s = await ready();
  const tag = final
    ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL
    : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  // Cast to libsodium's opaque state type. The runtime check inside
  // libsodium catches a state of the wrong shape — TypeScript can't see it.
  return s.crypto_secretstream_xchacha20poly1305_push(
    state as Parameters<typeof s.crypto_secretstream_xchacha20poly1305_push>[0],
    chunk,
    null,
    tag,
  );
}

/** Initialise a pull (decrypt) stream. Caller supplies the same 32-byte
 *  key and the 24-byte header written by the producer. Throws on bad
 *  header (corrupted / wrong-key-fingerprint). */
export async function streamPullInit(header: Uint8Array, key: Uint8Array): Promise<unknown> {
  const s = await ready();
  if (header.length !== s.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new Error(
      `streamPullInit: header must be ${s.crypto_secretstream_xchacha20poly1305_HEADERBYTES} bytes`,
    );
  }
  return s.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
}

export interface StreamPullResult {
  message: Uint8Array;
  /** True when this chunk carried the FINAL tag — the caller MUST refuse
   *  any further pulls and MUST verify they observed a FINAL before
   *  treating the decrypt as complete. */
  final: boolean;
}

/** Decrypt one chunk produced by `streamPush`. Throws when the AEAD tag
 *  fails verification (wrong key, tampered ciphertext, or out-of-order
 *  chunk) — libsodium-wrappers returns a falsy `message` field in that
 *  case rather than throwing, so we promote the failure here. */
export async function streamPull(state: unknown, chunk: Uint8Array): Promise<StreamPullResult> {
  const s = await ready();
  const r = s.crypto_secretstream_xchacha20poly1305_pull(
    state as Parameters<typeof s.crypto_secretstream_xchacha20poly1305_pull>[0],
    chunk,
    null,
  );
  // Verification failure: libsodium-wrappers signals this by returning a
  // shape with `message: undefined` (or `false` in some versions) instead
  // of throwing. Promote to a thrown error so callers don't accidentally
  // ship an undefined buffer to the rest of the decrypt pipeline.
  if (!r || !r.message) {
    throw new Error('streamPull: chunk failed authentication');
  }
  return { message: r.message, final: r.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL };
}

/** Constant exposed so framers know how big the per-chunk authenticator is. */
export async function streamABytes(): Promise<number> {
  const s = await ready();
  return s.crypto_secretstream_xchacha20poly1305_ABYTES;
}

/** Constant exposed so framers know the header size. */
export async function streamHeaderBytes(): Promise<number> {
  const s = await ready();
  return s.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
}
