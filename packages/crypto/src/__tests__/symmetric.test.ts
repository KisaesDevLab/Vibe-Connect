import { describe, expect, it } from 'vitest';
import {
  decryptMessage,
  encryptMessage,
  generateSymmetricKey,
  secretboxDecrypt,
  secretboxEncrypt,
  streamHeaderBytes,
  streamPull,
  streamPullInit,
  streamPush,
  streamPushInit,
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

describe('streaming secretstream', () => {
  async function newKey(): Promise<Uint8Array> {
    const s = await ready();
    return s.crypto_secretstream_xchacha20poly1305_keygen();
  }

  it('round-trips a single-chunk stream marked FINAL', async () => {
    const key = await newKey();
    const { header, state } = await streamPushInit(key);
    const expectedHeaderLen = await streamHeaderBytes();
    expect(header.length).toBe(expectedHeaderLen);
    const ct = await streamPush(state, utf8Encode('hello stream'), true);
    const pullState = await streamPullInit(header, key);
    const r = await streamPull(pullState, ct);
    expect(r.final).toBe(true);
    expect(utf8Decode(r.message)).toBe('hello stream');
  });

  it('round-trips a multi-chunk stream and the FINAL tag falls on the last chunk', async () => {
    const key = await newKey();
    const { header, state } = await streamPushInit(key);
    const chunks = ['the ', 'quick ', 'brown ', 'fox'];
    const cts: Uint8Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      cts.push(await streamPush(state, utf8Encode(chunks[i]!), isLast));
    }
    const pull = await streamPullInit(header, key);
    let acc = '';
    let sawFinal = false;
    for (let i = 0; i < cts.length; i++) {
      const r = await streamPull(pull, cts[i]!);
      acc += utf8Decode(r.message);
      if (i === cts.length - 1) {
        expect(r.final).toBe(true);
        sawFinal = true;
      } else {
        expect(r.final).toBe(false);
      }
    }
    expect(sawFinal).toBe(true);
    expect(acc).toBe('the quick brown fox');
  });

  it('rejects decryption with the wrong key', async () => {
    const k1 = await newKey();
    const k2 = await newKey();
    const { header, state } = await streamPushInit(k1);
    const ct = await streamPush(state, utf8Encode('secret'), true);
    await expect(streamPullInit(header, k2)).resolves.toBeDefined();
    // libsodium throws inside pull when the AEAD tag is wrong for this key.
    const wrongKeyPull = await streamPullInit(header, k2);
    await expect(streamPull(wrongKeyPull, ct)).rejects.toThrow();
  });

  it('rejects a tampered ciphertext chunk', async () => {
    const key = await newKey();
    const { header, state } = await streamPushInit(key);
    const ct = await streamPush(state, utf8Encode('payload'), true);
    const tampered = new Uint8Array(ct);
    tampered[0] = tampered[0]! ^ 0xff;
    const pull = await streamPullInit(header, key);
    await expect(streamPull(pull, tampered)).rejects.toThrow();
  });

  it('exposes header / authenticator sizes for framers', async () => {
    const s = await ready();
    expect(await streamHeaderBytes()).toBe(s.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
  });
});
