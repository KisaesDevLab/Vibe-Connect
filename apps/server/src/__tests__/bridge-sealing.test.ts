/**
 * BRIDGE regression: inbound email/SMS must never be stored as plaintext in messages.ciphertext.
 * The bridge seals the plaintext under a fresh symmetric key wrapped to the firm public key,
 * and the row carries ciphertext_meta.algorithm = 'bridge-sealed-v1'. The only way to open it is
 * the recovery phrase or a client-side rewrap after first staff access. This test asserts the
 * invariant end-to-end so a regression to 'plaintext-pending-rewrap' fails loudly.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
}, 120_000);

describe('bridge sealing invariant', () => {
  it('sealPlaintextForBridge produces a firm-sealed envelope, not plaintext', async () => {
    const { installFirmKey, emergencyUnwrapConversationKey, decryptMessage, utf8Decode } =
      await import('@vibe-connect/crypto');
    const { db } = await import('../db/knex.js');
    const artifacts = await installFirmKey();
    await db('firm_keys').del();
    await db('firm_keys').insert({
      public_key: artifacts.firm.publicKey,
      encrypted_recovery_private_key: artifacts.firm.encryptedRecoveryPrivateKey,
      kdf_params: artifacts.firm.kdfParams,
      kdf_salt: artifacts.firm.kdfSalt,
      rotation_version: 1,
    });

    const { sealPlaintextForBridge } = await import('../bridges/sealToFirm.js');
    const plaintext = 'this must not land in the DB as bytes';
    const sealed = await sealPlaintextForBridge(plaintext);

    // The stored buffer must NOT contain the plaintext.
    expect(sealed.toString('utf8').includes(plaintext)).toBe(false);

    // Parse envelope and confirm it's the expected shape.
    const env = JSON.parse(sealed.toString('utf8')) as {
      v: string;
      k: string;
      e: { n: string; c: string; v: number };
    };
    expect(env.v).toBe('bridge-sealed-v1');
    expect(typeof env.k).toBe('string');
    expect(env.e.n).toBeTruthy();
    expect(env.e.c).toBeTruthy();

    // Emergency recovery with the phrase opens it.
    const convKey = await emergencyUnwrapConversationKey(
      artifacts.firm,
      artifacts.recoveryPhrase,
      env.k,
    );
    const plain = await decryptMessage(env.e, convKey);
    expect(utf8Decode(plain)).toBe(plaintext);
  });
});
