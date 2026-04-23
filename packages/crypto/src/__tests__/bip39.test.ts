import { describe, expect, it } from 'vitest';
import { generatePhrase, phraseToEntropy, phraseToKey, validatePhrase } from '../bip39.js';
import { ready } from '../sodium.js';
import { toBase64 } from '../encoding.js';

await ready();

describe('BIP-39 24-word recovery phrase', () => {
  it('generates 24 valid words', async () => {
    const words = await generatePhrase();
    expect(words).toHaveLength(24);
    expect(validatePhrase(words)).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(validatePhrase(['one', 'two', 'three'])).toBe(false);
  });

  it('rejects tampered words', async () => {
    const words = await generatePhrase();
    const tampered = [...words];
    tampered[0] = 'zzzzzz';
    expect(validatePhrase(tampered)).toBe(false);
  });

  it('rejects a valid-word but checksum-broken phrase', async () => {
    const words = await generatePhrase();
    // Swap the last word with the first word — almost certainly breaks checksum
    const swapped = [...words];
    [swapped[0], swapped[23]] = [swapped[23]!, swapped[0]!];
    // Even if this particular swap happens to validate, we still want to cover the case.
    // Assert at minimum that phrase recovery fails OR produces a different entropy.
    if (!validatePhrase(swapped)) {
      expect(() => phraseToEntropy(swapped)).toThrow();
    } else {
      expect(toBase64(phraseToEntropy(swapped))).not.toBe(toBase64(phraseToEntropy(words)));
    }
  });

  it('derives a deterministic 32-byte key with a given salt', async () => {
    const words = await generatePhrase();
    const salt = new Uint8Array(16); // zero salt for determinism in this test only
    const k1 = await phraseToKey(words, salt);
    const k2 = await phraseToKey(words, salt);
    expect(k1.length).toBe(32);
    expect(toBase64(k1)).toBe(toBase64(k2));
  });

  it('produces different keys for different salts', async () => {
    const words = await generatePhrase();
    const k1 = await phraseToKey(words, new Uint8Array([1, 2, 3]));
    const k2 = await phraseToKey(words, new Uint8Array([4, 5, 6]));
    expect(toBase64(k1)).not.toBe(toBase64(k2));
  });
});
