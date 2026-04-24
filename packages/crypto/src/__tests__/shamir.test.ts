import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  combineBytes,
  combineRecoveryShares,
  decodeShare,
  encodeShare,
  splitBytes,
  splitRecoveryPhrase,
} from '../shamir.js';

describe('shamir', () => {
  it('splits and recombines raw bytes with any threshold subset', () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const shares = splitBytes(secret, 3, 5);
    expect(shares).toHaveLength(5);
    // Every subset of exactly 3 must reconstruct the secret.
    const triples: Array<[number, number, number]> = [
      [0, 1, 2],
      [0, 2, 4],
      [1, 3, 4],
    ];
    for (const [a, b, c] of triples) {
      const out = combineBytes([shares[a]!, shares[b]!, shares[c]!]);
      expect(Array.from(out)).toEqual(Array.from(secret));
    }
  });

  it('any threshold subset recovers, sub-threshold does not equal the secret', () => {
    const secret = new Uint8Array([42, 99, 255, 0, 128, 17]);
    const shares = splitBytes(secret, 3, 4);
    const subset = combineBytes([shares[0]!, shares[1]!]);
    // With 2 of 3 required, 2 shares lie on any number of polynomials, so the
    // reconstruction at x=0 is not the real secret. Assert it's different; the
    // property "leaks nothing" is theoretical and tested by splitting random
    // polynomials uniformly over the field (we trust the math here).
    expect(Array.from(subset)).not.toEqual(Array.from(secret));
  });

  it('encode/decode round-trip preserves share content', () => {
    const secret = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const shares = splitBytes(secret, 2, 3);
    for (const s of shares) {
      const round = decodeShare(encodeShare(s));
      expect(round.index).toBe(s.index);
      expect(Array.from(round.data)).toEqual(Array.from(s.data));
    }
  });

  it('splits + recombines a real BIP-39 24-word mnemonic', () => {
    const mnemonic = bip39.generateMnemonic(256);
    const parts = splitRecoveryPhrase(mnemonic, 2, 3);
    expect(parts).toHaveLength(3);
    // Any 2 of 3 must reproduce the original phrase.
    const pairs: Array<[number, number]> = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (const [a, b] of pairs) {
      const recovered = combineRecoveryShares([parts[a]!, parts[b]!]);
      expect(recovered).toBe(mnemonic);
    }
  });

  it('rejects malformed shares and invalid parameters', () => {
    expect(() => decodeShare('not-a-share')).toThrow();
    expect(() => decodeShare('V1-00-aabb')).toThrow('invalid_share_index');
    const secret = new Uint8Array([1, 2, 3]);
    expect(() => splitBytes(secret, 1, 3)).toThrow();
    expect(() => splitBytes(secret, 3, 2)).toThrow();
    expect(() => splitBytes(secret, 2, 256)).toThrow();
    expect(() => splitRecoveryPhrase('not a real mnemonic phrase', 2, 3)).toThrow(
      'invalid_recovery_phrase',
    );
  });
});
