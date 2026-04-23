import { describe, expect, it } from 'vitest';
import {
  decryptMessage,
  encryptMessage,
  generateSymmetricKey,
  secretboxDecrypt,
  secretboxEncrypt,
} from '../symmetric.js';
import { ready } from '../sodium.js';
import { utf8Decode, utf8Encode, fromBase64, toBase64 } from '../encoding.js';

await ready();

describe('symmetric XChaCha20-Poly1305', () => {
  it('round-trips a message', async () => {
    const key = await generateSymmetricKey();
    const envelope = await encryptMessage(utf8Encode('hello, vibe'), key, 1);
    expect(envelope.v).toBe(1);
    const plain = await decryptMessage(envelope, key);
    expect(utf8Decode(plain)).toBe('hello, vibe');
  });

  it('honors associated data', async () => {
    const key = await generateSymmetricKey();
    const ad = utf8Encode('conversation-abc');
    const env = await encryptMessage(utf8Encode('hi'), key, 1, ad);
    await expect(decryptMessage(env, key)).rejects.toThrow();
    await expect(decryptMessage(env, key, utf8Encode('other'))).rejects.toThrow();
    const ok = await decryptMessage(env, key, ad);
    expect(utf8Decode(ok)).toBe('hi');
  });

  it('rejects a tampered ciphertext byte', async () => {
    const key = await generateSymmetricKey();
    const env = await encryptMessage(utf8Encode('secret'), key, 1);
    const bytes = fromBase64(env.c);
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = { ...env, c: toBase64(bytes) };
    await expect(decryptMessage(tampered, key)).rejects.toThrow();
  });

  it('rejects a tampered nonce', async () => {
    const key = await generateSymmetricKey();
    const env = await encryptMessage(utf8Encode('secret'), key, 1);
    const nonceBytes = fromBase64(env.n);
    nonceBytes[0] = nonceBytes[0]! ^ 0x01;
    const tampered = { ...env, n: toBase64(nonceBytes) };
    await expect(decryptMessage(tampered, key)).rejects.toThrow();
  });

  it('rejects decryption with the wrong key', async () => {
    const keyA = await generateSymmetricKey();
    const keyB = await generateSymmetricKey();
    const env = await encryptMessage(utf8Encode('x'), keyA, 1);
    await expect(decryptMessage(env, keyB)).rejects.toThrow();
  });

  it('secretbox round-trip', async () => {
    const key = await generateSymmetricKey();
    const blob = await secretboxEncrypt(utf8Encode('wrapped'), key);
    const plain = await secretboxDecrypt(blob, key);
    expect(utf8Decode(plain)).toBe('wrapped');
  });
});
