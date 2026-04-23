// Password / phrase KDFs (Argon2id13) via libsodium.
// CRYPTO: only these functions may derive symmetric keys from human secrets.
import { ready } from './sodium.js';

/** Tuned for a 2022+ workstation; interactive profile. Server reads the stored params to re-derive. */
export const DEFAULT_KDF_OPS = 3;
export const DEFAULT_KDF_MEM = 256 * 1024 * 1024; // 256 MB

export interface KdfParams {
  opsLimit: number;
  memLimit: number;
  algorithm: 'argon2id13';
}

export async function randomSalt(): Promise<Uint8Array> {
  const s = await ready();
  return s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
}

export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  params: KdfParams = {
    opsLimit: DEFAULT_KDF_OPS,
    memLimit: DEFAULT_KDF_MEM,
    algorithm: 'argon2id13',
  },
): Promise<Uint8Array> {
  const s = await ready();
  return s.crypto_pwhash(
    s.crypto_secretbox_KEYBYTES, // 32 bytes
    password,
    salt,
    params.opsLimit,
    params.memLimit,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}
