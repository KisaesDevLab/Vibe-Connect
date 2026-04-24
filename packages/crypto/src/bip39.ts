// BIP-39 24-word firm recovery phrase.
// CRYPTO: root of the emergency-access capability. 24 words = 256 bits of entropy.
import * as bip39 from 'bip39';
import { ready, sodium } from './sodium.js';

export const PHRASE_WORD_COUNT = 24;
export const PHRASE_ENTROPY_BITS = 256;

// Pin the wordlist explicitly. Without this, a bip39 upgrade that changes
// the default locale would silently start producing non-English phrases,
// which (a) breaks every existing recovery flow that expects English words
// and (b) would be invisible to tests that compare derived key bytes.
const WORDLIST = bip39.wordlists.english;

/** Generate a fresh 24-word recovery phrase with canonical BIP-39 checksum. */
export async function generatePhrase(): Promise<string[]> {
  await ready();
  const mnemonic = bip39.generateMnemonic(PHRASE_ENTROPY_BITS, undefined, WORDLIST);
  return mnemonic.split(/\s+/);
}

export function validatePhrase(words: string[]): boolean {
  if (words.length !== PHRASE_WORD_COUNT) return false;
  return bip39.validateMnemonic(words.join(' '), WORDLIST);
}

export function phraseToEntropy(words: string[]): Uint8Array {
  if (!validatePhrase(words)) throw new Error('invalid recovery phrase');
  const hex = bip39.mnemonicToEntropy(words.join(' '), WORDLIST);
  return hexToBytes(hex);
}

/**
 * Derive a 32-byte symmetric key from the phrase.
 *
 * CRYPTO: this is BLAKE2b-256 (via libsodium's crypto_generichash) keyed by
 * the stored salt. No memory-hard KDF — deliberately — because the 24-word
 * BIP-39 phrase carries 256 bits of entropy and memory hardness adds no
 * attacker cost when the input space is already computationally intractable.
 * Argon2id would be inappropriate here (it's for low-entropy passwords, not
 * 256-bit secrets). See packages/crypto/src/device.ts for the
 * passphrase→device-key path that DOES use Argon2id.
 */
export async function phraseToKey(words: string[], salt: Uint8Array): Promise<Uint8Array> {
  await ready();
  const entropy = phraseToEntropy(words);
  return sodium().crypto_generichash(32, entropy, salt);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
