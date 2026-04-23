// Firm master keypair lifecycle + recovery-phrase emergency access.
// CRYPTO: the root of the firm-recoverable trust model.
import { generateKeypair, unwrapKey, wrapKey } from './asymmetric.js';
import { fromBase64, toBase64 } from './encoding.js';
import { randomSalt } from './kdf.js';
import { phraseToKey, generatePhrase } from './bip39.js';
import { secretboxDecrypt, secretboxEncrypt } from './symmetric.js';

// The 24-word BIP-39 phrase already carries 256 bits of entropy, so a memory-hard KDF
// adds no attacker cost. We derive the wrapping key with BLAKE2b-256 (via libsodium's
// crypto_generichash) keyed by the stored salt. Any change to this derivation must bump
// the algorithm tag and add a versioned fallback in recoverFirmPrivateKey.
export interface FirmKeyRecord {
  publicKey: string; // base64 X25519 public
  encryptedRecoveryPrivateKey: string; // phrase-wrapped secretkey, base64
  kdfSalt: string; // base64
  kdfParams: { algorithm: 'blake2b-256-phrase-v1' };
  rotationVersion: number;
}

export interface FirmInstallArtifacts {
  firm: FirmKeyRecord;
  /** Words to show the managing partner ONCE. Never store server-side. */
  recoveryPhrase: string[];
  /** In-memory private key, held by the server only until first restart. */
  privateKey: string;
}

export async function installFirmKey(): Promise<FirmInstallArtifacts> {
  const { publicKey, secretKey } = await generateKeypair();
  const recoveryPhrase = await generatePhrase();
  const salt = await randomSalt();
  const wrappingKey = await phraseToKey(recoveryPhrase, salt);
  const wrapped = await secretboxEncrypt(fromBase64(secretKey), wrappingKey);
  return {
    firm: {
      publicKey,
      encryptedRecoveryPrivateKey: wrapped,
      kdfSalt: toBase64(salt),
      kdfParams: { algorithm: 'blake2b-256-phrase-v1' },
      rotationVersion: 1,
    },
    recoveryPhrase,
    privateKey: secretKey,
  };
}

export async function recoverFirmPrivateKey(
  record: FirmKeyRecord,
  recoveryPhrase: string[],
): Promise<string> {
  const salt = fromBase64(record.kdfSalt);
  const wrappingKey = await phraseToKey(recoveryPhrase, salt);
  const raw = await secretboxDecrypt(record.encryptedRecoveryPrivateKey, wrappingKey);
  return toBase64(raw);
}

/** Wrap a conversation key to the firm public key so the recovery phrase can unlock it later. */
export async function wrapToFirm(symmetricKey: Uint8Array, firmPublicKey: string): Promise<string> {
  return wrapKey(symmetricKey, firmPublicKey);
}

export async function unwrapWithFirmPrivate(
  wrapped: string,
  firmPublicKey: string,
  firmPrivateKey: string,
): Promise<Uint8Array> {
  return unwrapKey(wrapped, firmPublicKey, firmPrivateKey);
}
