// BIP-39 24-word firm recovery phrase.
// CRYPTO: root of the emergency-access capability. 24 words = 256 bits of entropy.
import * as bip39 from 'bip39';
import { ready, sodium } from './sodium.js';

export const PHRASE_WORD_COUNT = 24;
export const PHRASE_ENTROPY_BITS = 256;

/** Generate a fresh 24-word recovery phrase with canonical BIP-39 checksum. */
export async function generatePhrase(): Promise<string[]> {
  await ready();
  const mnemonic = bip39.generateMnemonic(PHRASE_ENTROPY_BITS);
  return mnemonic.split(/\s+/);
}

export function validatePhrase(words: string[]): boolean {
  if (words.length !== PHRASE_WORD_COUNT) return false;
  return bip39.validateMnemonic(words.join(' '));
}

export function phraseToEntropy(words: string[]): Uint8Array {
  if (!validatePhrase(words)) throw new Error('invalid recovery phrase');
  const hex = bip39.mnemonicToEntropy(words.join(' '));
  return hexToBytes(hex);
}

/** Derive a 32-byte symmetric key from the phrase via Argon2id-like strengthening. */
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
