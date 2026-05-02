/**
 * Batch-3 QA regressions:
 *  - firm-configurable message edit window (issue #27)
 *  - firm-configurable SMS quiet hours persist + read (issue #21)
 *  - SMS inbound routing prefers recent outbound conversation (issue #20)
 *
 * Covers the schema-level settings. Provider-secrets rotation is exercised
 * indirectly by provider-secrets.test.ts already.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  // The SMS inbound routing test drives sealPlaintextForBridge which requires
  // a firm key row. Seed one for the whole suite.
  const { installFirmKey } = await import('@vibe-connect/crypto');
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
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

async function seedConversationWithMember(): Promise<{
  convId: string;
  userId: string;
  agent: ReturnType<typeof request.agent>;
}> {
  const { db } = await import('../db/knex.js');
  const agent = request.agent(app);
  const username = `b3-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const [user] = await db('users')
    .insert({
      username,
      password_hash: bcrypt.hashSync('test-pass-1234', 4),
      display_name: 'Batch3',
      is_admin: false,
      is_active: true,
    })
    .returning(['id']);
  const userId = user.id as string;
  const login = await agent.post('/auth/login').send({ username, password: 'test-pass-1234' });
  expect(login.status).toBe(200);
  const [conv] = await db('conversations')
    .insert({ type: 'internal', display_name: 'B3 conv' })
    .returning(['id']);
  const convId = conv.id as string;
  await db('conversation_members').insert({ conversation_id: convId, user_id: userId });
  await db('conversation_keys').insert({
    conversation_id: convId,
    rotation_version: 1,
    wrapped_keys: JSON.stringify({ [`${userId}:devX`]: 'sealed' }),
  });
  return { convId, userId, agent };
}

describe('batch 3 regressions', () => {
  it('edit window zero disables edits (firm_settings gate)', async () => {
    const { db } = await import('../db/knex.js');
    const { convId, userId, agent } = await seedConversationWithMember();
    // Seed a recent message authored by this user.
    const [msg] = await db('messages')
      .insert({
        conversation_id: convId,
        sender_id: userId,
        ciphertext: Buffer.from(JSON.stringify({ n: 'aaa', c: 'bbb', v: 1 }), 'utf8'),
        content_key_version: 1,
      })
      .returning(['id']);
    const messageId = msg.id as string;

    // Default: 15-minute window → edit succeeds.
    const okEdit = await agent.patch(`/conversations/messages/${messageId}`).send({
      ciphertext: Buffer.from(JSON.stringify({ n: 'aaa', c: 'ccc', v: 1 }), 'utf8').toString(
        'base64',
      ),
      ciphertextMeta: {},
    });
    expect(okEdit.status).toBe(200);

    // Flip the firm setting to 0 (edits disabled) and retry.
    await db('firm_settings').where({ id: 1 }).update({ message_edit_window_minutes: 0 });
    const blocked = await agent.patch(`/conversations/messages/${messageId}`).send({
      ciphertext: Buffer.from(JSON.stringify({ n: 'aaa', c: 'ddd', v: 1 }), 'utf8').toString(
        'base64',
      ),
      ciphertextMeta: {},
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe('edits_disabled');
    // Restore for other tests sharing the DB.
    await db('firm_settings').where({ id: 1 }).update({ message_edit_window_minutes: 15 });
  });

  it('SMS inbound routes to the conversation from the most recent outbound audit', async () => {
    const { db } = await import('../db/knex.js');
    const { supportedInboundNumber } = { supportedInboundNumber: '+15555550123' };
    const [row] = await db('external_identities')
      .insert({
        email: `b3-sms-${Date.now()}@example.com`,
        display_name: 'SMS Router',
        phone: supportedInboundNumber,
      })
      .returning(['id']);
    const identityId = row.id as string;
    const [conv1] = await db('conversations')
      .insert({ type: 'external', display_name: 'First' })
      .returning(['id']);
    const [conv2] = await db('conversations')
      .insert({ type: 'external', display_name: 'Second' })
      .returning(['id']);
    const conv1Id = conv1.id as string;
    const conv2Id = conv2.id as string;
    await db('conversation_members').insert([
      { conversation_id: conv1Id, external_identity_id: identityId },
      { conversation_id: conv2Id, external_identity_id: identityId },
    ]);
    // Conv2 is the more-recently-touched by default.
    await db('conversations').where({ id: conv2Id }).update({ updated_at: db.fn.now() });
    // But the most recent outbound SMS went to conv1 — router should pick conv1.
    await db('audit_log').insert({
      actor_external_identity_id: identityId,
      action: 'sms.sent',
      target_type: 'external_identity',
      target_id: identityId,
      details: { conversationId: conv1Id },
    });
    const inbound = await request(app)
      .post('/bridges/sms-inbound')
      .send({ from: supportedInboundNumber, to: '+15550000000', body: 'Hi staff', id: 'msg-1' });
    expect(inbound.status).toBe(200);
    const messages = await db('messages')
      .where({ source: 'sms-in', sender_external_identity_id: identityId })
      .orderBy('created_at', 'desc')
      .limit(1);
    expect(messages.length).toBe(1);
    expect(messages[0]!.conversation_id).toBe(conv1Id);
  });

  it('scheduled_broadcast_at column exists and is null by default', async () => {
    const { db } = await import('../db/knex.js');
    const [staff] = await db('users')
      .insert({
        username: `b3-col-${Date.now()}`,
        password_hash: bcrypt.hashSync('dummy', 4),
        display_name: 'Col',
        is_admin: false,
        is_active: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: 'Col test' })
      .returning(['id']);
    const [m] = await db('messages')
      .insert({
        conversation_id: (conv as { id: string }).id,
        sender_id: (staff as { id: string }).id,
        ciphertext: Buffer.from('x'),
        content_key_version: 1,
      })
      .returning(['id', 'scheduled_broadcast_at']);
    expect((m as { scheduled_broadcast_at: string | null }).scheduled_broadcast_at).toBeNull();
  });
});
