// HMAC-signed unsubscribe tokens. Prevents trivial UUID-enumeration unsubscribe attacks.
// Token format: base64url(<externalIdentityId>|<version>).base64url(HMAC-SHA256(...,  env.sessionSecret))
import crypto from 'node:crypto';
import { env } from '../env.js';

const VERSION = 'u1';

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
}

export function signUnsubscribeToken(externalIdentityId: string): string {
  const payload = `${VERSION}|${externalIdentityId}`;
  return `${b64u(payload)}.${hmac(payload)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
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
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  const [version, id] = payload.split('|');
  if (version !== VERSION || !id) return null;
  // UUID sanity check so we don't return arbitrary strings.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  return id;
}
