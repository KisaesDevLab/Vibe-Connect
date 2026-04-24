// Shared KEK-backed sealing for at-rest secrets (provider credentials, ACME
// account keys, anything else the appliance must hold but admins must never
// see plaintext of).
//
// KEK: HKDF-SHA256(SESSION_SECRET, salt='vibe-connect/provider-secrets/v1',
//      length=32). Derived once per process, held in memory only. Rotating
//      SESSION_SECRET invalidates every sealed value.
// Cipher: libsodium secretbox (XSalsa20-Poly1305), via @vibe-connect/crypto.
//
// Two callers today: services/providerSecrets.ts and services/tlsAcme.ts.
// Keeping the primitive here — not inlined — means the crypto invariant
// lives in exactly one place.
import { hkdfSync } from 'node:crypto';
import { env } from '../env.js';

let kekCache: Uint8Array | null = null;
function kek(): Uint8Array {
  if (kekCache) return kekCache;
  if (!env.sessionSecret) {
    throw new Error('kekSeal: SESSION_SECRET required to derive KEK');
  }
  const salt = Buffer.from('vibe-connect/provider-secrets/v1');
  const info = Buffer.from('kek');
  const out = hkdfSync('sha256', Buffer.from(env.sessionSecret), salt, info, 32);
  kekCache = new Uint8Array(out);
  return kekCache;
}

export async function sealString(plaintext: string): Promise<string> {
  const { secretboxEncrypt } = await import('@vibe-connect/crypto');
  return secretboxEncrypt(new TextEncoder().encode(plaintext), kek());
}

export async function unsealString(sealed: string): Promise<string> {
  const { secretboxDecrypt } = await import('@vibe-connect/crypto');
  const pt = await secretboxDecrypt(sealed, kek());
  return new TextDecoder().decode(pt);
}
