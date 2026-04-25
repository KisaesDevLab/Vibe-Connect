/**
 * Phase 4 — End-to-end encrypt → upload → fetch → decrypt via packages/crypto.
 * The server never sees plaintext. These tests verify that the ciphertext round-trips and
 * that permission checks fire as expected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type * as CryptoMod from '@vibe-connect/crypto';
import { resetTestDb } from './test-helpers.js';

let app: Express;
let crypto: typeof CryptoMod;

async function loginAs(username: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  const me = await agent.get('/auth/me');
  return { agent, userId: me.body.user.id as string };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  crypto = await import('@vibe-connect/crypto');
  await crypto.ready();
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

// See auth.test.ts for why afterAll doesn't destroy the pool.

describe('conversation + messaging E2EE', () => {
  it('two-person conversation: encrypt → upload ciphertext → fetch → decrypt', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');

    // Each party generates a device keypair. In production this happens in-browser;
    // here we call the same crypto package.
    const kurtDevice = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const kurtSecret = await crypto.unlockDevicePrivateKey(kurtDevice, 'kurt-dev-only-ChangeMe!');
    const aliceDevice = await crypto.enrollDevice({
      password: 'alice-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const aliceSecret = await crypto.unlockDevicePrivateKey(
      aliceDevice,
      'alice-dev-only-ChangeMe!',
    );

    // Client-side: create the conversation key and wrap it per recipient.
    const kurtRecipientId = 'kurt-device-1';
    const aliceRecipientId = 'alice-device-1';
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: kurtRecipientId, publicKey: kurtDevice.publicKey },
      { id: aliceRecipientId, publicKey: aliceDevice.publicKey },
    ]);

    // Kurt creates the conversation.
    const created = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: bundle.rotationVersion,
    });
    expect(created.status).toBe(201);
    const convId = created.body.id as string;

    // Kurt sends a message. He encrypts with the conversation key and uploads ciphertext.
    const plaintext = 'Reviewed quarterly filings — looks clean.';
    const envelope = await crypto.encryptMessage(
      crypto.utf8Encode(plaintext),
      bundle.key,
      bundle.rotationVersion,
    );
    // Wire ciphertext as base64; server stores as BYTEA.
    const wire = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    const posted = await kurt.agent.post(`/conversations/${convId}/messages`).send({
      ciphertext: wire,
      contentKeyVersion: bundle.rotationVersion,
      urgent: false,
      ciphertextMeta: {},
    });
    expect(posted.status).toBe(201);

    // Alice fetches — needs the wrappedKeys to unwrap the conversation key, then decrypts.
    const convDetail = await alice.agent.get(`/conversations/${convId}`);
    expect(convDetail.status).toBe(200);
    expect(convDetail.body.wrappedKeys[aliceRecipientId]).toBeTruthy();

    const aliceKey = await crypto.unwrapConversationKey(
      convDetail.body.wrappedKeys as Record<string, string>,
      aliceRecipientId,
      aliceDevice.publicKey,
      aliceSecret,
    );

    const msgs = await alice.agent.get(`/conversations/${convId}/messages`);
    expect(msgs.status).toBe(200);
    expect(msgs.body.messages).toHaveLength(1);
    const stored = msgs.body.messages[0];
    const envelopeBack = JSON.parse(
      Buffer.from(stored.ciphertext, 'base64').toString('utf8'),
    ) as typeof envelope;
    const decrypted = crypto.utf8Decode(await crypto.decryptMessage(envelopeBack, aliceKey));
    expect(decrypted).toBe(plaintext);

    // And Kurt can decrypt his own message too.
    const kurtKey = await crypto.unwrapConversationKey(
      convDetail.body.wrappedKeys as Record<string, string>,
      kurtRecipientId,
      kurtDevice.publicKey,
      kurtSecret,
    );
    const decKurt = crypto.utf8Decode(await crypto.decryptMessage(envelopeBack, kurtKey));
    expect(decKurt).toBe(plaintext);
  });

  it('non-member cannot fetch messages', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');

    const dev = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const { wrappedKeys } = await crypto.createConversationKey([
      { id: 'k1', publicKey: dev.publicKey },
    ]);

    const r = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: 1,
    });
    const convId = r.body.id as string;

    const bobTries = await bob.agent.get(`/conversations/${convId}/messages`);
    expect(bobTries.status).toBe(403);
    expect(bobTries.body.error).toBe('not_a_member');
  });

  it('edit/delete obey sender + 15-minute window', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');

    const dev = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: 'd', publicKey: dev.publicKey },
    ]);
    const created = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: 1,
    });
    const convId = created.body.id as string;

    const env = await crypto.encryptMessage(crypto.utf8Encode('original'), bundle.key, 1);
    const wire = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    const posted = await kurt.agent
      .post(`/conversations/${convId}/messages`)
      .send({ ciphertext: wire, contentKeyVersion: 1 });
    const msgId = posted.body.id as string;

    // Alice cannot edit Kurt's message.
    const aliceEdit = await alice.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: wire,
      ciphertextMeta: {},
    });
    expect(aliceEdit.status).toBe(403);

    // Kurt can edit.
    const env2 = await crypto.encryptMessage(crypto.utf8Encode('edited'), bundle.key, 1);
    const kurtEdit = await kurt.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: Buffer.from(JSON.stringify(env2), 'utf8').toString('base64'),
      ciphertextMeta: {},
    });
    expect(kurtEdit.status).toBe(200);

    // Alice cannot delete Kurt's message.
    const aliceDel = await alice.agent.delete(`/conversations/messages/${msgId}`);
    expect(aliceDel.status).toBe(403);

    // Kurt can soft-delete.
    const kurtDel = await kurt.agent.delete(`/conversations/messages/${msgId}`);
    expect(kurtDel.status).toBe(200);

    // Phase 27: deleted messages stay in the list as a tombstone so the UI
    // can render the "Message deleted" placeholder. Ciphertext + meta are
    // stripped on the wire, but the DB row keeps the bytes for admin
    // recovery.
    const list = await kurt.agent.get(`/conversations/${convId}/messages`);
    expect(list.body.messages).toHaveLength(1);
    expect(list.body.messages[0].deletedAt).not.toBeNull();
    expect(list.body.messages[0].ciphertext).toBe('');
    expect(list.body.messages[0].ciphertextMeta).toBeNull();
  });

  it('scheduled messages are hidden until scheduledFor ≤ now', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const dev = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: 'd', publicKey: dev.publicKey },
    ]);
    const created = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: 1,
    });
    const convId = created.body.id as string;

    const env = await crypto.encryptMessage(crypto.utf8Encode('future'), bundle.key, 1);
    const wire = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await kurt.agent.post(`/conversations/${convId}/messages`).send({
      ciphertext: wire,
      contentKeyVersion: 1,
      scheduledFor: future,
    });

    const list = await alice.agent.get(`/conversations/${convId}/messages`);
    expect(list.body.messages).toHaveLength(0);
  });

  it('read receipt updates last_read pointer', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const dev = await crypto.enrollDevice({
      password: 'kurt-dev-only-ChangeMe!',
      deviceId: crypto.newDeviceId(),
      clientPlatform: 'web',
      clientVersion: '0.1.0',
    });
    const { bundle, wrappedKeys } = await crypto.createConversationKey([
      { id: 'd', publicKey: dev.publicKey },
    ]);
    const created = await kurt.agent.post('/conversations').send({
      type: 'internal',
      memberUserIds: [kurt.userId, alice.userId],
      wrappedKeys,
      rotationVersion: 1,
    });
    const convId = created.body.id as string;

    const env = await crypto.encryptMessage(crypto.utf8Encode('x'), bundle.key, 1);
    const wire = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
    const posted = await kurt.agent
      .post(`/conversations/${convId}/messages`)
      .send({ ciphertext: wire, contentKeyVersion: 1 });
    const mid = posted.body.id as string;

    const mark = await alice.agent.post(`/conversations/messages/${mid}/read`);
    expect(mark.status).toBe(200);
  });
});
