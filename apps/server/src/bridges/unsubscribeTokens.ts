// Unsubscribe tokens.
//
// Two formats are supported:
//   u1: base64url(version|externalIdentityId).base64url(HMAC-SHA256)
//       Legacy. The identity UUID is readable by anyone with the URL
//       (including inbox-scanning malware, link-preview bots, etc.). We
//       keep verification support so outstanding emails with u1 links still
//       work, but new tokens use u2.
//
//   u2: "u2." + base64url(nonce || secretbox(version|externalIdentityId))
//       The payload is encrypted + authenticated with XChaCha20-Poly1305
//       (via @vibe-connect/crypto.secretbox*) under a KEK derived from
//       SESSION_SECRET via HKDF. The identity UUID is no longer visible in
//       the URL. No HMAC needed — secretbox is already authenticated.
//
// Rotating SESSION_SECRET invalidates every outstanding unsubscribe link.
// That's a known consequence documented in docs/ops/SESSION_SECRET_ROTATION.md.
//
// CRYPTO: primitives are taken from @vibe-connect/crypto; direct libsodium
// imports are disallowed per CLAUDE.md.
import crypto from 'node:crypto';
import { secretboxDecrypt, secretboxEncrypt } from '@vibe-connect/crypto';
import { env } from '../env.js';

const VERSION_V1 = 'u1';
const VERSION_V2 = 'u2';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function b64u(buf: Buffer | string): string {
  if (typeof buf === 'string') return Buffer.from(buf).toString('base64url');
  return Buffer.from(buf).toString('base64url');
}

// Legacy u1 helpers (kept for verifying existing emails).
function hmac(payload: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

function unsubscribeKek(): Uint8Array {
  return new Uint8Array(
    crypto.hkdfSync('sha256', env.sessionSecret, Buffer.alloc(0), 'vibe-connect-unsubscribe-v2', 32),
  );
}

/**
 * Sign an unsubscribe token for a given external identity. Uses the v2
 * (encrypted) format — the identity UUID is not recoverable without the KEK.
 * Async because the underlying crypto package is async-initialized.
 */
export async function signUnsubscribeToken(externalIdentityId: string): Promise<string> {
  const payload = `${VERSION_V2}|${externalIdentityId}`;
  const blob = await secretboxEncrypt(
    new TextEncoder().encode(payload),
    unsubscribeKek(),
  );
  // secretboxEncrypt returns base64 (not base64url). Re-encode to keep the
  // token URL-safe and prefix with the version tag so verifyUnsubscribeToken
  // can pick the right path without parsing cost.
  const rebase = Buffer.from(blob, 'base64').toString('base64url');
  return `${VERSION_V2}.${rebase}`;
}

/**
 * Synchronous signer for callers that can't await (e.g., code paths inside
 * a non-async context). Issues a u1 token — the UUID is HMAC-authenticated
 * but not encrypted. Prefer `signUnsubscribeToken` in new code.
 */
export function signUnsubscribeTokenLegacy(externalIdentityId: string): string {
  const payload = `${VERSION_V1}|${externalIdentityId}`;
  return `${b64u(payload)}.${hmac(payload)}`;
}

export async function verifyUnsubscribeToken(token: string): Promise<string | null> {
  if (token.startsWith(`${VERSION_V2}.`)) {
    return verifyV2(token.slice(VERSION_V2.length + 1));
  }
  return verifyV1(token);
}

async function verifyV2(encoded: string): Promise<string | null> {
  let blobBase64: string;
  try {
    blobBase64 = Buffer.from(encoded, 'base64url').toString('base64');
  } catch {
    return null;
  }
  let plain: Uint8Array;
  try {
    plain = await secretboxDecrypt(blobBase64, unsubscribeKek());
  } catch {
    return null;
  }
  const payload = new TextDecoder().decode(plain);
  const [version, id] = payload.split('|');
  if (version !== VERSION_V2 || !id) return null;
  if (!UUID_RE.test(id)) return null;
  return id;
}

function verifyV1(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = hmac(payload);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(sig, 'base64url');
    b = Buffer.from(expected, 'base64url');
  } catch {
    return null;
  }
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const [version, id] = payload.split('|');
  if (version !== VERSION_V1 || !id) return null;
  if (!UUID_RE.test(id)) return null;
  return id;
}
