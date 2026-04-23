import { describe, expect, it } from 'vitest';
import {
  installFirmKey,
  recoverFirmPrivateKey,
  unwrapWithFirmPrivate,
  wrapToFirm,
} from '../firm.js';
import { ready } from '../sodium.js';
import { generateSymmetricKey } from '../symmetric.js';
import { toBase64 } from '../encoding.js';

await ready();

describe('firm master keypair', () => {
  it('install returns a 24-word phrase and a public/private pair', async () => {
    const artifacts = await installFirmKey();
    expect(artifacts.recoveryPhrase).toHaveLength(24);
    expect(artifacts.firm.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(artifacts.privateKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(artifacts.firm.encryptedRecoveryPrivateKey).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('recovery phrase recovers the private key; wrong phrase fails', async () => {
    const a = await installFirmKey();
    const recovered = await recoverFirmPrivateKey(a.firm, a.recoveryPhrase);
    expect(recovered).toBe(a.privateKey);

    // A different install's phrase must not unlock this record.
    const b = await installFirmKey();
    await expect(recoverFirmPrivateKey(a.firm, b.recoveryPhrase)).rejects.toThrow();
  });

  it('wrap to firm → recover with phrase → unwrap symmetric key', async () => {
    const artifacts = await installFirmKey();
    const sym = await generateSymmetricKey();
    const wrapped = await wrapToFirm(sym, artifacts.firm.publicKey);

    // Admin initiates audit: provides the phrase, gets the private key back, unwraps.
    const recoveredPriv = await recoverFirmPrivateKey(artifacts.firm, artifacts.recoveryPhrase);
    const unwrapped = await unwrapWithFirmPrivate(wrapped, artifacts.firm.publicKey, recoveredPriv);
    expect(toBase64(unwrapped)).toBe(toBase64(sym));
  });
});
