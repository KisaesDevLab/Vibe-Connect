// Phase 28.4 — HS256 JWT helper for intake upload tokens.
//
// The token is what an anonymous walk-up client carries from the form
// (POST /api/public/intake/sessions) to the upload pipeline (POST
// /api/public/intake/uploads, landing in 28.5). It identifies the session
// and proves the bearer holds the freshly-minted credential — anyone
// posting bytes against the tus endpoint must present a token whose
// `jti` matches the session row's `upload_token_jti`.
//
// CRYPTO posture:
//   - HS256 (HMAC-SHA256). Asymmetric isn't needed — the server signs and
//     verifies; nothing else touches this token.
//   - Signing key is HKDF-SHA256(SESSION_SECRET, salt, info), DISTINCT from
//     both the intake content key (CONNECT_INTAKE_ENCRYPTION_KEY, see
//     services/intakeCrypto.ts) and the search subkey. Rotating either of
//     those keys doesn't invalidate live upload tokens. Rotating
//     SESSION_SECRET does — but rotating SESSION_SECRET already
//     invalidates every session cookie, sealed provider cred, and ACME
//     account key in the appliance, so a few minutes of in-flight intake
//     uploads getting rejected is a trivial part of that operation.
//   - No nacl/libsodium use here; HMAC-SHA256 is in node's standard
//     library and CLAUDE.md's "no crypto outside packages/crypto" rule is
//     about envelope primitives, not symmetric MACs. (Same logic as
//     hashForAudit/searchHash in services/intakeCrypto.ts.)
//
// We hand-roll the JWT shape rather than adding `jsonwebtoken` or `jose`
// — fewer dependencies, ~30 lines total, and the format is fixed (no need
// to read alg headers from untrusted input). The JWT spec allows extra
// signature length, but our verifier is strict: header, payload, and
// signature are exactly the three base64url segments we wrote.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

const TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 h, per Phase 28.4 spec.

let cachedKey: Uint8Array | null = null;
function signingKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  if (!env.sessionSecret) {
    throw new Error('SESSION_SECRET is required to derive the intake upload-token key');
  }
  const salt = Buffer.from('vibe-connect/intake-upload-token/v1');
  const info = Buffer.from('sign');
  cachedKey = new Uint8Array(hkdfSync('sha256', Buffer.from(env.sessionSecret), salt, info, 32));
  return cachedKey;
}

/** Test-only cache reset. Production code never calls this. */
export function __resetIntakeUploadTokenCache(): void {
  cachedKey = null;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface UploadTokenClaims {
  /** Intake session id (uuid). The tus PATCH route uses this to look up
   *  the session and verify it is still `open`. */
  sid: string;
  /** Assigned staff user id (uuid). Carried for audit + so the upload
   *  service can re-check membership in the session row without an extra
   *  DB roundtrip. */
  staff: string;
  /** JWT id — random opaque string, matches `intake_sessions.upload_token_jti`
   *  (UNIQUE constraint). Re-presenting an old token after the column has
   *  rotated (session finalized / abandoned) verifies signature OK but
   *  fails the JTI lookup. */
  jti: string;
  /** Seconds since epoch. */
  exp: number;
  /** Seconds since epoch. */
  iat: number;
}

export function signUploadToken(claims: Omit<UploadTokenClaims, 'exp' | 'iat'>): {
  token: string;
  expiresAt: Date;
} {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const fullClaims: UploadTokenClaims = { ...claims, exp, iat: now };
  // Standard JWT header — we always emit alg HS256 / typ JWT and the
  // verifier rejects anything else (defense against alg-confusion attacks).
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify(fullClaims)));
  const signingInput = `${header}.${payload}`;
  const sig = createHmac('sha256', signingKey()).update(signingInput).digest();
  return {
    token: `${signingInput}.${base64url(sig)}`,
    expiresAt: new Date(exp * 1000),
  };
}

export type VerifyResult =
  | { ok: true; claims: UploadTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'bad_alg' | 'expired' | 'bad_payload' };

export function verifyUploadToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Verify signature first so we never decode an unauthenticated payload
  // into structured form (defense against type-juggling on attacker-
  // controlled JSON).
  const expected = createHmac('sha256', signingKey())
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let provided: Buffer;
  try {
    provided = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };

  // Header check after signature verification. alg-confusion attacks
  // (`alg: none`, `alg: RS256` with HMAC-keyed-as-public-key) only matter
  // for libraries that pick verification alg from the header — we don't,
  // but we still reject non-HS256 tokens so a future maintainer can't
  // accidentally introduce that footgun by trusting the header.
  let header: unknown;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>).alg !== 'HS256' ||
    (header as Record<string, unknown>).typ !== 'JWT'
  ) {
    return { ok: false, reason: 'bad_alg' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'bad_payload' };
  }
  const p = payload as Record<string, unknown>;
  if (
    typeof p.sid !== 'string' ||
    typeof p.staff !== 'string' ||
    typeof p.jti !== 'string' ||
    typeof p.exp !== 'number' ||
    typeof p.iat !== 'number'
  ) {
    return { ok: false, reason: 'bad_payload' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (p.exp <= now) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: { sid: p.sid, staff: p.staff, jti: p.jti, exp: p.exp, iat: p.iat },
  };
}
