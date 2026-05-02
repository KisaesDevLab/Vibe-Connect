// Shamir Secret Sharing over GF(2^8). Used to split the 24-word firm recovery phrase's
// underlying entropy (32 bytes for 256-bit entropy) across N partners with a threshold K.
//
// CRYPTO: this file must ONLY be called through the higher-level `splitRecoveryPhrase`
// and `combineRecoveryShares` helpers, which go through BIP-39 entropy conversion first.
// Never split the mnemonic string directly — share boundaries mid-word would leak structure.
//
// Test vectors live alongside in __tests__/shamir.test.ts. Do not replace or optimize
// without updating the tests.

import * as bip39 from 'bip39';

// Precomputed log/antilog tables for GF(2^8) with reducing polynomial 0x11b (AES-style).
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= x << 1;
    if (x & 0x100) x ^= 0x11b;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  if (a === 0) return 0;
  return EXP[LOG[a]! - LOG[b]! + 255]!;
}

function evalPoly(coeffs: number[], x: number): number {
  // Horner's method in GF(256). coeffs[0] is the constant term (the secret byte).
  let result = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ coeffs[i]!;
  }
  return result;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(out);
  } else {
    // Node fallback; browsers always have webcrypto.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const nodeCrypto = require('node:crypto');
    const buf = nodeCrypto.randomBytes(n);
    out.set(buf);
  }
  return out;
}

export interface ShamirShare {
  /** 1-byte share index, 1..N. Never 0 (that's the secret itself). */
  index: number;
  /** secret-byte-length, one GF(256) evaluation at x=index per secret byte. */
  data: Uint8Array;
}

/** Split a raw byte secret into `total` shares, any `threshold` of which recover the secret. */
export function splitBytes(secret: Uint8Array, threshold: number, total: number): ShamirShare[] {
  if (threshold < 2) throw new Error('threshold must be at least 2');
  if (total < threshold) throw new Error('total must be >= threshold');
  if (total > 255) throw new Error('total must be <= 255');
  if (secret.length === 0) throw new Error('empty secret');

  const shares: ShamirShare[] = Array.from({ length: total }, (_, i) => ({
    index: i + 1,
    data: new Uint8Array(secret.length),
  }));

  // For each secret byte, draw (threshold - 1) random coefficients and evaluate at 1..total.
  for (let b = 0; b < secret.length; b++) {
    const coeffs = [secret[b]!, ...Array.from(randomBytes(threshold - 1))];
    for (let s = 0; s < total; s++) {
      shares[s]!.data[b] = evalPoly(coeffs, shares[s]!.index);
    }
  }
  return shares;
}

/** Reconstruct a secret from any `threshold` or more shares via Lagrange interpolation at x=0. */
export function combineBytes(shares: ShamirShare[]): Uint8Array {
  if (shares.length < 2) throw new Error('at least two shares required');
  const len = shares[0]!.data.length;
  for (const s of shares) {
    if (s.data.length !== len) throw new Error('share length mismatch');
    if (s.index < 1 || s.index > 255) throw new Error('invalid share index');
  }
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let secretByte = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      const xi = shares[i]!.index;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        const xj = shares[j]!.index;
        // Lagrange basis L_i(0) = prod_{j!=i} (-xj) / (xi - xj). In GF(256), -x == x.
        num = gfMul(num, xj);
        den = gfMul(den, xi ^ xj);
      }
      const coeff = gfDiv(num, den);
      secretByte ^= gfMul(shares[i]!.data[b]!, coeff);
    }
    out[b] = secretByte;
  }
  return out;
}

/** Encode a share as a human-transferable hex string prefixed with its index. */
export function encodeShare(share: ShamirShare): string {
  if (share.index < 1 || share.index > 255) throw new Error('invalid share index');
  const idx = share.index.toString(16).padStart(2, '0');
  const body = Array.from(share.data, (b) => b.toString(16).padStart(2, '0')).join('');
  return `V1-${idx}-${body}`;
}

export function decodeShare(text: string): ShamirShare {
  const m = /^V1-([0-9a-f]{2})-([0-9a-f]+)$/i.exec(text.trim());
  if (!m) throw new Error('malformed_share');
  const idx = parseInt(m[1]!, 16);
  if (idx < 1 || idx > 255) throw new Error('invalid_share_index');
  const bytes = m[2]!;
  if (bytes.length % 2 !== 0) throw new Error('odd_share_length');
  const data = new Uint8Array(bytes.length / 2);
  for (let i = 0; i < data.length; i++) {
    data[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  }
  return { index: idx, data };
}

/**
 * Split a BIP-39 recovery phrase into N encoded shares with threshold K.
 * The phrase is converted to its canonical entropy bytes first, so the shares are exactly
 * the 24-word phrase's 32-byte entropy plus a 1-byte index.
 */
export function splitRecoveryPhrase(phrase: string, threshold: number, total: number): string[] {
  const trimmed = phrase.trim().split(/\s+/).join(' ');
  if (!bip39.validateMnemonic(trimmed)) throw new Error('invalid_recovery_phrase');
  const entropyHex = bip39.mnemonicToEntropy(trimmed);
  const entropy = new Uint8Array(entropyHex.length / 2);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entropyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const shares = splitBytes(entropy, threshold, total);
  return shares.map(encodeShare);
}

/**
 * Reconstruct a BIP-39 recovery phrase from at least the threshold number of encoded shares.
 * Throws if the reconstructed entropy is not a valid BIP-39 mnemonic (checksum mismatch).
 */
export function combineRecoveryShares(encoded: string[]): string {
  const shares = encoded.map(decodeShare);
  const entropy = combineBytes(shares);
  const hex = Array.from(entropy, (b) => b.toString(16).padStart(2, '0')).join('');
  const phrase = bip39.entropyToMnemonic(hex);
  if (!bip39.validateMnemonic(phrase)) throw new Error('reconstructed_phrase_invalid');
  return phrase;
}
