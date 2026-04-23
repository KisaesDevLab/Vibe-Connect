/**
 * End-to-end crypto path:
 *  install firm key → enroll 3 staff devices + 1 client session → create conversation key wrapped
 *  to all of them + the firm → encrypt a message → each recipient decrypts → member removal
 *  rotates the key → the removed member can no longer decrypt a NEW message.
 */
import { describe, expect, it } from 'vitest';
import { enrollDevice, newDeviceId, unlockDevicePrivateKey } from '../device.js';
import { generateKeypair } from '../asymmetric.js';
import {
  createConversationKey,
  incrementalWrap,
  rewrapForSameMembership,
  rotateConversationKey,
  unwrapConversationKey,
} from '../conversation.js';
import { installFirmKey } from '../firm.js';
import { decryptMessage, encryptMessage } from '../symmetric.js';
import { ready } from '../sodium.js';
import { emergencyUnwrapConversationKey } from '../emergency.js';
import { utf8Decode, utf8Encode, toBase64 } from '../encoding.js';

await ready();

async function freshDevice(password = 'test-pass-long-enough') {
  const enrolled = await enrollDevice({
    password,
    deviceId: newDeviceId(),
    clientPlatform: 'pwa',
    clientVersion: '0.1.0',
  });
  const secretKey = await unlockDevicePrivateKey(enrolled, password);
  return {
    id: newDeviceId(),
    publicKey: enrolled.publicKey,
    secretKey,
  };
}

describe('conversation lifecycle', () => {
  it('all recipients can decrypt the same message', async () => {
    const firm = await installFirmKey();
    const alice = await freshDevice();
    const bob = await freshDevice();
    const clientSession = await generateKeypair();

    const recipients = [
      { id: alice.id, publicKey: alice.publicKey },
      { id: bob.id, publicKey: bob.publicKey },
      { id: 'client-session-1', publicKey: clientSession.publicKey },
      { id: 'firm', publicKey: firm.firm.publicKey },
    ];
    const { bundle, wrappedKeys } = await createConversationKey(recipients);
    expect(bundle.rotationVersion).toBe(1);

    const env = await encryptMessage(utf8Encode('joint task update'), bundle.key, 1);

    // Alice
    const aKey = await unwrapConversationKey(
      wrappedKeys,
      alice.id,
      alice.publicKey,
      alice.secretKey,
    );
    expect(utf8Decode(await decryptMessage(env, aKey))).toBe('joint task update');
    // Bob
    const bKey = await unwrapConversationKey(wrappedKeys, bob.id, bob.publicKey, bob.secretKey);
    expect(utf8Decode(await decryptMessage(env, bKey))).toBe('joint task update');
    // Client
    const cKey = await unwrapConversationKey(
      wrappedKeys,
      'client-session-1',
      clientSession.publicKey,
      clientSession.secretKey,
    );
    expect(utf8Decode(await decryptMessage(env, cKey))).toBe('joint task update');
  });

  it('incremental wrap: new member reads future messages', async () => {
    const alice = await freshDevice();
    const recipients = [{ id: alice.id, publicKey: alice.publicKey }];
    const { bundle, wrappedKeys } = await createConversationKey(recipients);

    const bob = await freshDevice();
    wrappedKeys[bob.id] = await incrementalWrap(bundle.key, {
      id: bob.id,
      publicKey: bob.publicKey,
    });

    const env = await encryptMessage(utf8Encode('welcome bob'), bundle.key, 1);
    const bKey = await unwrapConversationKey(wrappedKeys, bob.id, bob.publicKey, bob.secretKey);
    expect(utf8Decode(await decryptMessage(env, bKey))).toBe('welcome bob');
  });

  it('rotation on member removal: removed member cannot decrypt new ciphertext', async () => {
    const alice = await freshDevice();
    const bob = await freshDevice();
    const recipients = [
      { id: alice.id, publicKey: alice.publicKey },
      { id: bob.id, publicKey: bob.publicKey },
    ];
    const { bundle: v1 } = await createConversationKey(recipients);

    // Bob is removed: rotate
    const { bundle: v2, wrappedKeys: wrappedV2 } = await rotateConversationKey(
      [{ id: alice.id, publicKey: alice.publicKey }],
      v1.rotationVersion,
    );
    expect(v2.rotationVersion).toBe(2);

    const env = await encryptMessage(utf8Encode('after bob left'), v2.key, 2);
    // Alice OK
    const aKey = await unwrapConversationKey(wrappedV2, alice.id, alice.publicKey, alice.secretKey);
    expect(utf8Decode(await decryptMessage(env, aKey))).toBe('after bob left');
    // Bob: no wrapped key for him in v2
    await expect(
      unwrapConversationKey(wrappedV2, bob.id, bob.publicKey, bob.secretKey),
    ).rejects.toThrow();
  });

  it('rewrapForSameMembership reissues wrapped entries without a new key', async () => {
    const alice = await freshDevice();
    const bob = await freshDevice();
    const { bundle } = await createConversationKey([
      { id: alice.id, publicKey: alice.publicKey },
      { id: bob.id, publicKey: bob.publicKey },
    ]);
    const next = await rewrapForSameMembership(bundle.key, [
      { id: alice.id, publicKey: alice.publicKey },
      { id: bob.id, publicKey: bob.publicKey },
    ]);
    expect(Object.keys(next).sort()).toEqual([alice.id, bob.id].sort());
    const aKey = await unwrapConversationKey(next, alice.id, alice.publicKey, alice.secretKey);
    expect(toBase64(aKey)).toBe(toBase64(bundle.key));
  });

  it('emergency decryption via recovery phrase', async () => {
    const firm = await installFirmKey();
    const alice = await freshDevice();
    const { bundle, wrappedKeys } = await createConversationKey([
      { id: alice.id, publicKey: alice.publicKey },
      { id: 'firm', publicKey: firm.firm.publicKey },
    ]);
    const env = await encryptMessage(utf8Encode('billing dispute detail'), bundle.key, 1);

    const conversationKey = await emergencyUnwrapConversationKey(
      firm.firm,
      firm.recoveryPhrase,
      wrappedKeys['firm']!,
    );
    const plain = await decryptMessage(env, conversationKey);
    expect(utf8Decode(plain)).toBe('billing dispute detail');
  });
});
