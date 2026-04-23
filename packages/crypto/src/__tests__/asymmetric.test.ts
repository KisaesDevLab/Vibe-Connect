import { describe, expect, it } from 'vitest';
import { generateKeypair, unwrapKey, wrapKey } from '../asymmetric.js';
import { generateSymmetricKey } from '../symmetric.js';
import { ready } from '../sodium.js';
import { fromBase64, toBase64 } from '../encoding.js';

await ready();

describe('X25519 sealed box wrap/unwrap', () => {
  it('round-trips a symmetric key through a recipient keypair', async () => {
    const recipient = await generateKeypair();
    const symKey = await generateSymmetricKey();
    const wrapped = await wrapKey(symKey, recipient.publicKey);
    const unwrapped = await unwrapKey(wrapped, recipient.publicKey, recipient.secretKey);
    expect(toBase64(unwrapped)).toBe(toBase64(symKey));
  });

  it('rejects a malformed wrapped blob', async () => {
    const recipient = await generateKeypair();
    await expect(
      unwrapKey('not-base64!!!!', recipient.publicKey, recipient.secretKey),
    ).rejects.toThrow();
  });

  it('rejects unwrapping with the wrong private key', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const symKey = await generateSymmetricKey();
    const wrapped = await wrapKey(symKey, a.publicKey);
    await expect(unwrapKey(wrapped, b.publicKey, b.secretKey)).rejects.toThrow();
  });

  it('rejects a tampered wrapped blob', async () => {
    const recipient = await generateKeypair();
    const symKey = await generateSymmetricKey();
    const wrapped = await wrapKey(symKey, recipient.publicKey);
    const raw = fromBase64(wrapped);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    await expect(
      unwrapKey(toBase64(raw), recipient.publicKey, recipient.secretKey),
    ).rejects.toThrow();
  });
});
