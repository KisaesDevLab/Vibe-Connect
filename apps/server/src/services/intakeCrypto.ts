// Phase 28 — Vibe File Transfer (Intake) crypto helpers.
//
// CRYPTO: every encrypt/decrypt on intake content goes through this module.
// Feature code never imports `@vibe-connect/crypto` directly for intake
// purposes (same rule as kekSeal.ts for sealed provider creds).
//
// Posture: server-side encryption at rest with a firm-held libsodium key.
// NOT E2EE — see docs/ADR-028-server-side-encryption-rationale.md. The
// intake key is a separate root of trust from SESSION_SECRET so the Phase
// 28.16 rotation route can re-encrypt every intake blob without touching
// sessions, sealed provider creds, or ACME state (and vice-versa).
//
// Primitives:
//   Field encryption (PII columns)   libsodium secretbox (XSalsa20-Poly1305)
//                                    via @vibe-connect/crypto.secretboxEncrypt
//                                    base64 → Buffer round-trip so columns
//                                    stay `bytea` per the Phase 28.1 plan.
//   Audit hash (PII hashing)         HMAC-SHA256 with the intake key as the
//                                    key. Deterministic but tied to the
//                                    intake key — rotating the key means
//                                    historical audit hashes can't be
//                                    re-computed (acceptable; audit rows
//                                    just lose hash-collision lookup, not
//                                    their content).
//   Search hash (deterministic)      HKDF-SHA256(SESSION_SECRET, salt) →
//                                    fixed HMAC subkey. *Independent of
//                                    the intake key* so rotating the intake
//                                    key does not break staff search over
//                                    intake_sessions. See Phase 28.11.
//
// Stream encryption (`encryptFileStream` / `decryptFileStream`) wraps the
// Phase 28.5 streaming primitives added to `packages/crypto` (secretstream
// XChaCha20-Poly1305). The chunked envelope written to disk is:
//
//   header (24 bytes)
//   [u32 BE length][ct chunk] (repeated; last chunk carries the FINAL tag)
//
// Readers that swallow a stream lacking a FINAL tag would lose truncation
// resilience — decryptFileStream asserts this.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { env } from '../env.js';

let cachedKey: Uint8Array | null = null;
let cachedSearchSubkey: Uint8Array | null = null;

function intakeKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const raw = env.connectIntakeEncryptionKey;
  if (!raw) {
    throw new Error(
      'CONNECT_INTAKE_ENCRYPTION_KEY is required before intake encryption/decryption is invoked. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('CONNECT_INTAKE_ENCRYPTION_KEY is not valid base64');
  }
  if (buf.length !== 32) {
    throw new Error(
      `CONNECT_INTAKE_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
        'libsodium secretbox keys are 256 bits.',
    );
  }
  cachedKey = new Uint8Array(buf);
  return cachedKey;
}

/**
 * HKDF-SHA256(SESSION_SECRET, salt='vibe-connect/intake-search/v1') → 32-byte
 * HMAC subkey. Deliberately keyed off SESSION_SECRET, not the intake content
 * key, so Phase 28.16 key rotation does not invalidate the deterministic
 * `client_email_hash` / `client_phone_hash` / `client_name_lower_hash`
 * sidecar columns that Phase 28.11 staff search depends on.
 */
function searchSubkey(): Uint8Array {
  if (cachedSearchSubkey) return cachedSearchSubkey;
  if (!env.sessionSecret) {
    throw new Error('SESSION_SECRET is required to derive the intake search subkey');
  }
  const salt = Buffer.from('vibe-connect/intake-search/v1');
  const info = Buffer.from('intake-search-subkey');
  cachedSearchSubkey = new Uint8Array(
    hkdfSync('sha256', Buffer.from(env.sessionSecret), salt, info, 32),
  );
  return cachedSearchSubkey;
}

/**
 * Encrypt a UTF-8 string field (client name, email, phone, etc.) to a raw
 * Buffer holding `nonce || ciphertext+tag`. Stored as a `bytea` column.
 *
 * Routes through `@vibe-connect/crypto.secretboxEncrypt` (which returns
 * base64) and re-decodes to raw bytes so the on-disk size stays compact
 * and the column type matches the migration spec — the round-trip cost is
 * microseconds per call and irrelevant for the short PII strings this is
 * used for.
 */
export async function encryptField(plaintext: string): Promise<Buffer> {
  return encryptFieldWith(plaintext, intakeKey());
}

/**
 * Inverse of `encryptField`. Accepts a Buffer (the bytea row value) or a
 * Uint8Array; returns the decrypted UTF-8 string. Throws on tampering /
 * wrong key — secretbox tag verification is authenticated.
 */
export async function decryptField(ct: Buffer | Uint8Array): Promise<string> {
  return decryptFieldWith(ct, intakeKey());
}

/**
 * Phase 28.16 — explicit-key encrypt. Used by the key-rotation worker to
 * re-encrypt every PII column under a new key while production reads
 * continue against the cached (current) key. NOT exposed to feature code.
 */
export async function encryptFieldWith(plaintext: string, key: Uint8Array): Promise<Buffer> {
  assertKeyLength(key);
  const { secretboxEncrypt } = await import('@vibe-connect/crypto');
  const b64 = await secretboxEncrypt(new TextEncoder().encode(plaintext), key);
  return Buffer.from(b64, 'base64');
}

/**
 * Phase 28.16 — explicit-key decrypt. Mirror of `encryptFieldWith`.
 */
export async function decryptFieldWith(ct: Buffer | Uint8Array, key: Uint8Array): Promise<string> {
  assertKeyLength(key);
  const { secretboxDecrypt } = await import('@vibe-connect/crypto');
  const buf = Buffer.isBuffer(ct) ? ct : Buffer.from(ct);
  const pt = await secretboxDecrypt(buf.toString('base64'), key);
  return new TextDecoder().decode(pt);
}

/**
 * Decode + validate a base64 intake key string into a 32-byte Uint8Array.
 * Phase 28.16 rotation reads two of these (old + new). Throws with the
 * same messaging shape as the env-var path so the route handler can
 * surface a useful 400 to the admin.
 */
export function parseIntakeKey(raw: string, label: string): Uint8Array {
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (buf.length !== 32) {
    throw new Error(
      `${label} must decode to exactly 32 bytes (got ${buf.length}). libsodium secretbox keys are 256 bits.`,
    );
  }
  return new Uint8Array(buf);
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error('intake key must be 32 bytes (256 bits)');
  }
}

/**
 * Sentinel returned by `hashForAudit` when the intake key isn't configured.
 * Audit rows written during a misconfigured-appliance window record this
 * placeholder instead of crashing; the audit viewer can surface "key
 * missing during this window" as an operator hygiene signal without the
 * misconfiguration cascading into a 500 on every public intake probe.
 *
 * Exported so tests + audit viewers can recognize it explicitly.
 */
export const HASH_FOR_AUDIT_UNKEYED = 'unkeyed-no-intake-key';

let warnedUnkeyed = false;

/**
 * Deterministic HMAC-SHA256 over a plaintext value, keyed by the intake
 * content key. Use this for audit-event payload fields where the operator
 * needs to correlate two audit rows ("same client uploaded twice?") without
 * the plaintext being recoverable from the log.
 *
 * NOT for staff search — see `searchHash` instead. The audit hash rotates
 * with the intake key (intentional: historical audit rows can be tied to
 * pre-rotation plaintexts but not to post-rotation ones).
 *
 * Tolerates a missing key: if `CONNECT_INTAKE_ENCRYPTION_KEY` is unset the
 * function returns `HASH_FOR_AUDIT_UNKEYED` and logs a one-shot warning
 * instead of throwing. Audit hashing is observability — it should never
 * cascade an environment misconfiguration into a 500 response on a public
 * route. Without this defense, an anonymous client probing
 * `/api/public/intake/links/<bad-token>` on a server whose operator
 * forgot to generate the intake key gets a 500 instead of the intended
 * 404, leaking server-misconfig state.
 */
export function hashForAudit(plaintext: string): string {
  try {
    return createHmac('sha256', intakeKey()).update(plaintext, 'utf8').digest('base64url');
  } catch (err) {
    if (!warnedUnkeyed) {
      warnedUnkeyed = true;
      // Plain console.warn to avoid an import cycle with logger.ts (which
      // imports services indirectly). One-shot per process; the operator
      // sees this once at first audit attempt, not on every request.
      console.warn(
        '[intakeCrypto] hashForAudit called without CONNECT_INTAKE_ENCRYPTION_KEY set;',
        'audit rows will record the unkeyed sentinel until the env var is configured.',
        'Original error:',
        err instanceof Error ? err.message : String(err),
      );
    }
    return HASH_FOR_AUDIT_UNKEYED;
  }
}

/**
 * Test-only: reset the one-shot warning latch so tests can re-exercise
 * the warning path. Production code never calls this.
 */
export function __resetHashForAuditWarn(): void {
  warnedUnkeyed = false;
}

/**
 * Deterministic HMAC-SHA256 over a plaintext value, keyed by the HKDF-derived
 * search subkey. Stored in the `client_email_hash` / `client_phone_hash` /
 * `client_name_lower_hash` sidecar columns on `intake_sessions` so Phase
 * 28.11 staff search can look up sessions by client contact without
 * needing to decrypt every PII column on every query.
 *
 * Independent of the intake content key — rotating the intake key (Phase
 * 28.16) does not invalidate search hashes. Rotating SESSION_SECRET (a far
 * rarer operation that breaks every sealed provider cred and every active
 * session anyway) does invalidate them, which is acceptable: search is a
 * convenience, not a correctness invariant.
 */
export function searchHash(plaintext: string): string {
  return createHmac('sha256', searchSubkey()).update(plaintext, 'utf8').digest('base64url');
}

/**
 * Constant-time equality helper for caller-side comparison of search-hash
 * values (e.g. probing whether two intake sessions came from the same
 * email). Exposed here so feature code never imports `crypto.timingSafeEqual`
 * directly with mismatched-length inputs (Node throws on that).
 */
export function searchHashEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'base64url');
  const bBuf = Buffer.from(b, 'base64url');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Test-only reset. Cleared between Vitest suites that mutate
 * `CONNECT_INTAKE_ENCRYPTION_KEY` so subsequent suites pick up the new
 * value. Production code never calls this.
 */
export function __resetIntakeCryptoCache(): void {
  cachedKey = null;
  cachedSearchSubkey = null;
}

// -------- Streaming file encryption (Phase 28.5) --------
//
// Chunk size for the framed-on-disk envelope. 64 KiB matches the message-
// attachment encryption path's expectations and keeps the per-chunk
// overhead (17 bytes AEAD tag + 4 bytes length prefix) under 0.04 % of
// each ciphertext chunk. Small enough that mid-stream sharp errors get
// detected promptly; big enough that a 50 MB upload generates ~800 chunks
// of bookkeeping.
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * Return a Node Transform stream that consumes plaintext and emits the
 * Phase 28.5 chunked envelope (24-byte header followed by length-prefixed
 * AEAD-sealed chunks; FINAL tag on the last chunk).
 *
 * The transform never holds more than ~2 × STREAM_CHUNK_BYTES of plaintext
 * in memory — incoming buffers are sliced into per-chunk ciphertexts as
 * they arrive. Callers MUST end the input stream cleanly (no `destroy()`
 * without `end()`) so the FINAL tag actually gets written; the decrypt
 * stream rejects any tail-truncated input.
 */
export async function encryptFileStream(): Promise<Transform> {
  const { streamPushInit, streamPush } = await import('@vibe-connect/crypto');
  const init = await streamPushInit(intakeKey());

  let buffered = Buffer.alloc(0);
  let headerWritten = false;

  const transform = new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      try {
        if (!headerWritten) {
          transform.push(Buffer.from(init.header));
          headerWritten = true;
        }
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= STREAM_CHUNK_BYTES) {
          const slice = buffered.subarray(0, STREAM_CHUNK_BYTES);
          buffered = buffered.subarray(STREAM_CHUNK_BYTES);
          const ct = await streamPush(init.state, slice, false);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(ct.length, 0);
          transform.push(len);
          transform.push(Buffer.from(ct));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    async flush(cb) {
      try {
        if (!headerWritten) {
          // Empty input — still need a valid envelope: write the header
          // followed by a single empty FINAL chunk so the decrypt path
          // sees a well-formed stream.
          transform.push(Buffer.from(init.header));
          headerWritten = true;
        }
        // Drain whatever's left as the FINAL chunk (may be empty).
        const finalCt = await streamPush(init.state, buffered, true);
        buffered = Buffer.alloc(0);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(finalCt.length, 0);
        transform.push(len);
        transform.push(Buffer.from(finalCt));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  return transform;
}

/**
 * Return a Node Transform stream that consumes the Phase 28.5 chunked
 * envelope produced by `encryptFileStream` and emits plaintext bytes.
 *
 * Throws if the input ends without a FINAL-tagged chunk — that's the
 * truncation defense the streaming AEAD construction is meant to provide,
 * and silently accepting a stream that was cut short loses it.
 */
export async function decryptFileStream(): Promise<Transform> {
  const { streamPullInit, streamPull, streamHeaderBytes } = await import('@vibe-connect/crypto');
  const headerLen = await streamHeaderBytes();
  let state: unknown | null = null;
  let buf = Buffer.alloc(0);
  let sawFinal = false;

  const transform = new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        // 1) Consume the 24-byte header if we don't have one yet.
        if (state === null) {
          if (buf.length < headerLen) {
            cb();
            return;
          }
          const header = buf.subarray(0, headerLen);
          buf = buf.subarray(headerLen);
          state = await streamPullInit(new Uint8Array(header), intakeKey());
        }
        // 2) Consume zero or more length-prefixed ciphertext chunks.
        //    Stop as soon as we don't have a full chunk's worth of bytes
        //    so we don't block waiting on more input.
        while (buf.length >= 4) {
          const chunkLen = buf.readUInt32BE(0);
          if (buf.length < 4 + chunkLen) break;
          const ct = buf.subarray(4, 4 + chunkLen);
          buf = buf.subarray(4 + chunkLen);
          const r = await streamPull(state, new Uint8Array(ct));
          if (r.final) sawFinal = true;
          transform.push(Buffer.from(r.message));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      if (!sawFinal) {
        cb(new Error('decryptFileStream: stream ended without FINAL chunk (truncated?)'));
        return;
      }
      if (buf.length > 0) {
        cb(new Error('decryptFileStream: trailing bytes after FINAL chunk'));
        return;
      }
      cb();
    },
  });
  return transform;
}

/**
 * Convenience helper: pipe a plaintext readable through the encrypt
 * transform and resolve with the assembled ciphertext Buffer. Used by
 * the intake upload finalize path where the tus chunks are already
 * sitting in a partial file on disk and the simplest path is read →
 * encrypt → write.
 */
export async function encryptBufferStreaming(plain: Buffer): Promise<Buffer> {
  return encryptBufferStreamingWith(plain, intakeKey());
}

/**
 * Convenience helper: feed a ciphertext Buffer through the decrypt
 * transform and resolve with the recovered plaintext. Mostly for tests
 * and the staff "decrypt to download" UI path in Phase 28.11.
 */
export async function decryptBufferStreaming(ct: Buffer): Promise<Buffer> {
  return decryptBufferStreamingWith(ct, intakeKey());
}

/**
 * Phase 28.16 — explicit-key streaming encrypt. The key-rotation worker
 * pipes ciphertext through `decryptBufferStreamingWith(oldKey)` then
 * `encryptBufferStreamingWith(newKey)`. Returns the assembled ciphertext.
 *
 * Memory note: this fully buffers the file in memory. For Phase 28.16 the
 * upper bound is `firm_settings.intake_max_file_bytes` (default 50 MB).
 * Re-encrypting a 5 GB file would OOM — a future streaming-to-tmpfile
 * variant should land before raising the per-file cap.
 */
export async function encryptBufferStreamingWith(plain: Buffer, key: Uint8Array): Promise<Buffer> {
  assertKeyLength(key);
  const { Readable } = await import('node:stream');
  const src = Readable.from([plain]);
  const enc = await encryptFileStreamWith(key);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    src.pipe(enc);
    enc.on('data', (b: Buffer) => chunks.push(b));
    enc.on('end', resolve);
    enc.on('error', reject);
  });
  return Buffer.concat(chunks);
}

/**
 * Phase 28.16 — explicit-key streaming decrypt. Mirror of
 * `encryptBufferStreamingWith`.
 */
export async function decryptBufferStreamingWith(ct: Buffer, key: Uint8Array): Promise<Buffer> {
  assertKeyLength(key);
  const { Readable } = await import('node:stream');
  const src = Readable.from([ct]);
  const dec = await decryptFileStreamWith(key);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    src.pipe(dec);
    dec.on('data', (b: Buffer) => chunks.push(b));
    dec.on('end', resolve);
    dec.on('error', reject);
  });
  return Buffer.concat(chunks);
}

/**
 * Phase 28.16 — explicit-key variant of `encryptFileStream`. Identical
 * envelope format; the caller supplies the secretstream key directly.
 */
export async function encryptFileStreamWith(key: Uint8Array): Promise<Transform> {
  assertKeyLength(key);
  const { streamPushInit, streamPush } = await import('@vibe-connect/crypto');
  const init = await streamPushInit(key);

  let buffered = Buffer.alloc(0);
  let headerWritten = false;

  const transform = new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      try {
        if (!headerWritten) {
          transform.push(Buffer.from(init.header));
          headerWritten = true;
        }
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= STREAM_CHUNK_BYTES) {
          const slice = buffered.subarray(0, STREAM_CHUNK_BYTES);
          buffered = buffered.subarray(STREAM_CHUNK_BYTES);
          const ct = await streamPush(init.state, slice, false);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(ct.length, 0);
          transform.push(len);
          transform.push(Buffer.from(ct));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    async flush(cb) {
      try {
        if (!headerWritten) {
          transform.push(Buffer.from(init.header));
          headerWritten = true;
        }
        const finalCt = await streamPush(init.state, buffered, true);
        buffered = Buffer.alloc(0);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(finalCt.length, 0);
        transform.push(len);
        transform.push(Buffer.from(finalCt));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  return transform;
}

/**
 * Phase 28.16 — explicit-key variant of `decryptFileStream`.
 */
export async function decryptFileStreamWith(key: Uint8Array): Promise<Transform> {
  assertKeyLength(key);
  const { streamPullInit, streamPull, streamHeaderBytes } = await import('@vibe-connect/crypto');
  const headerLen = await streamHeaderBytes();
  let state: unknown | null = null;
  let buf = Buffer.alloc(0);
  let sawFinal = false;

  const transform = new Transform({
    async transform(chunk: Buffer, _enc, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (state === null) {
          if (buf.length < headerLen) {
            cb();
            return;
          }
          const header = buf.subarray(0, headerLen);
          buf = buf.subarray(headerLen);
          state = await streamPullInit(new Uint8Array(header), key);
        }
        while (buf.length >= 4) {
          const chunkLen = buf.readUInt32BE(0);
          if (buf.length < 4 + chunkLen) break;
          const ct = buf.subarray(4, 4 + chunkLen);
          buf = buf.subarray(4 + chunkLen);
          const r = await streamPull(state, new Uint8Array(ct));
          if (r.final) sawFinal = true;
          transform.push(Buffer.from(r.message));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      if (!sawFinal) {
        cb(new Error('decryptFileStream: stream ended without FINAL chunk (truncated?)'));
        return;
      }
      if (buf.length > 0) {
        cb(new Error('decryptFileStream: trailing bytes after FINAL chunk'));
        return;
      }
      cb();
    },
  });
  return transform;
}

// Re-export Readable type for callers that need it without importing
// node:stream directly.
export type { Readable };
