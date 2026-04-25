/**
 * Phase 27 — Edit history, destruct timer, and admin recovery.
 *
 * Covers the contract pieces that conversations.test.ts doesn't:
 *   - Edit snapshots prior ciphertext into `message_edits`.
 *   - Soft-delete preserves the ciphertext bytes (admin recoverable).
 *   - Destruct stamp arms only on first non-sender read.
 *   - Sender self-reads don't arm the timer.
 *   - Repeat reads are no-ops, audit row fires once.
 *   - Send route rejects destruct when firm setting is off / cap exceeded.
 *   - Edit refuses after destruct timer has elapsed.
 *   - Destruct ticker soft-deletes due rows and writes audit.
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

async function bootstrap() {
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
  return { kurt, alice, convId: created.body.id as string, bundle };
}

async function send(
  kurt: Awaited<ReturnType<typeof loginAs>>,
  convId: string,
  body: string,
  bundle: { key: Uint8Array; rotationVersion: number },
  extra: Record<string, unknown> = {},
) {
  const env = await crypto.encryptMessage(crypto.utf8Encode(body), bundle.key, bundle.rotationVersion);
  const wire = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
  return kurt.agent
    .post(`/conversations/${convId}/messages`)
    .send({ ciphertext: wire, contentKeyVersion: bundle.rotationVersion, ...extra });
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

describe('Phase 27 — message edit/delete/destruct', () => {
  it('edit snapshots prior ciphertext into message_edits', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'first', bundle);
    const msgId = posted.body.id as string;

    const env2 = await crypto.encryptMessage(crypto.utf8Encode('second'), bundle.key, 1);
    const ed = await kurt.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: Buffer.from(JSON.stringify(env2), 'utf8').toString('base64'),
      ciphertextMeta: {},
    });
    expect(ed.status).toBe(200);

    const { db } = await import('../db/knex.js');
    const history = await db('message_edits').where({ message_id: msgId });
    expect(history).toHaveLength(1);
    expect(history[0].content_key_version).toBe(1);
    expect(Buffer.isBuffer(history[0].ciphertext)).toBe(true);
    expect((history[0].ciphertext as Buffer).length).toBeGreaterThan(0);
    expect(history[0].replaced_by_user_id).toBe(kurt.userId);
  });

  it('soft-delete keeps ciphertext bytes for admin recovery', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'recoverable', bundle);
    const msgId = posted.body.id as string;
    await kurt.agent.delete(`/conversations/messages/${msgId}`);

    const { db } = await import('../db/knex.js');
    const row = await db('messages').where({ id: msgId }).first();
    expect(row.deleted_at).not.toBeNull();
    expect((row.ciphertext as Buffer).length).toBeGreaterThan(0);
  });

  it('destruct timer arms on first non-sender read only', async () => {
    const { kurt, alice, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'goes-bye', bundle, {
      destructAfterViewSeconds: 60,
    });
    const msgId = posted.body.id as string;

    // Sender's own read must not arm.
    await kurt.agent.post(`/conversations/messages/${msgId}/read`);
    const { db } = await import('../db/knex.js');
    let row = await db('messages').where({ id: msgId }).first();
    expect(row.destruct_at).toBeNull();

    // Alice's read does arm.
    await alice.agent.post(`/conversations/messages/${msgId}/read`);
    row = await db('messages').where({ id: msgId }).first();
    expect(row.destruct_at).not.toBeNull();
    // pg returns timestamptz as a Date; compare via ISO so identity isn't a
    // factor (a fresh row read produces a fresh Date instance).
    const firstStamp = new Date(row.destruct_at).toISOString();

    // Repeat read does not move the stamp.
    await alice.agent.post(`/conversations/messages/${msgId}/read`);
    row = await db('messages').where({ id: msgId }).first();
    expect(new Date(row.destruct_at).toISOString()).toBe(firstStamp);

    // Audit row fired exactly once.
    const audits = await db('audit_log')
      .where({ action: 'message.destruct_armed', target_id: msgId });
    expect(audits).toHaveLength(1);
  });

  it('send route rejects destruct when firm setting is off', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ message_destruct_enabled: false });
    try {
      const r = await send(kurt, convId, 'nope', bundle, { destructAfterViewSeconds: 60 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('destruct_disabled');
    } finally {
      await db('firm_settings').where({ id: 1 }).update({ message_destruct_enabled: true });
    }
  });

  it('send route rejects destruct seconds above firm cap', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ message_destruct_max_seconds: 60 });
    try {
      const r = await send(kurt, convId, 'too-long', bundle, { destructAfterViewSeconds: 3600 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('destruct_seconds_too_large');
      expect(r.body.details.maxSeconds).toBe(60);
    } finally {
      await db('firm_settings').where({ id: 1 }).update({ message_destruct_max_seconds: 604800 });
    }
  });

  it('edit refuses after destruct timer elapsed', async () => {
    const { kurt, alice, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'fading', bundle, { destructAfterViewSeconds: 1 });
    const msgId = posted.body.id as string;
    await alice.agent.post(`/conversations/messages/${msgId}/read`);
    // Backdate destruct_at into the past so the route's `<= now()` check fires
    // without us actually waiting.
    const { db } = await import('../db/knex.js');
    await db('messages').where({ id: msgId }).update({ destruct_at: new Date(Date.now() - 1000) });

    const env2 = await crypto.encryptMessage(crypto.utf8Encode('late'), bundle.key, 1);
    const ed = await kurt.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: Buffer.from(JSON.stringify(env2), 'utf8').toString('base64'),
      ciphertextMeta: {},
    });
    expect(ed.status).toBe(400);
    expect(ed.body.error).toBe('destruct_pending');
  });

  it('destruct ticker soft-deletes due rows and writes audit', async () => {
    const { kurt, alice, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'tick', bundle, { destructAfterViewSeconds: 10 });
    const msgId = posted.body.id as string;
    await alice.agent.post(`/conversations/messages/${msgId}/read`);

    // Backdate destruct_at and run the ticker once.
    const { db } = await import('../db/knex.js');
    await db('messages').where({ id: msgId }).update({ destruct_at: new Date(Date.now() - 1000) });

    const { runOnce } = await import('../services/destructMessages.js');
    const fired = await runOnce();
    expect(fired).toBeGreaterThanOrEqual(1);

    const row = await db('messages').where({ id: msgId }).first();
    expect(row.deleted_at).not.toBeNull();
    expect((row.ciphertext as Buffer).length).toBeGreaterThan(0); // preserved for admin
    const audit = await db('audit_log').where({ action: 'message.destructed', target_id: msgId });
    expect(audit).toHaveLength(1);
  });

  it('admin history endpoint returns prior ciphertexts + key bundle', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'orig', bundle);
    const msgId = posted.body.id as string;
    const env2 = await crypto.encryptMessage(crypto.utf8Encode('next'), bundle.key, 1);
    await kurt.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: Buffer.from(JSON.stringify(env2), 'utf8').toString('base64'),
      ciphertextMeta: {},
    });

    const r = await kurt.agent.get(`/admin/messages/${msgId}/history`);
    expect(r.status).toBe(200);
    expect(r.body.message.id).toBe(msgId);
    expect(r.body.message.ciphertext).toBeTruthy();
    expect(r.body.edits).toHaveLength(1);
    expect(r.body.edits[0].ciphertext).toBeTruthy();
    expect(r.body.edits[0].contentKeyVersion).toBe(1);
    expect(r.body.edits[0].replacedByUserId).toBe(kurt.userId);
    expect(r.body.conversationKeys).toHaveLength(1);
    expect(r.body.conversationKeys[0].wrappedKeys).toBeTruthy();

    // Audit row was written.
    const { db } = await import('../db/knex.js');
    const audit = await db('audit_log')
      .where({ action: 'admin.message_history_viewed', target_id: msgId });
    expect(audit).toHaveLength(1);
  });

  it('writes message.edited audit on every edit', async () => {
    const { kurt, convId, bundle } = await bootstrap();
    const posted = await send(kurt, convId, 'pre', bundle);
    const msgId = posted.body.id as string;
    const env2 = await crypto.encryptMessage(crypto.utf8Encode('post'), bundle.key, 1);
    await kurt.agent.patch(`/conversations/messages/${msgId}`).send({
      ciphertext: Buffer.from(JSON.stringify(env2), 'utf8').toString('base64'),
      ciphertextMeta: {},
    });
    const { db } = await import('../db/knex.js');
    const audit = await db('audit_log').where({ action: 'message.edited', target_id: msgId });
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(kurt.userId);
  });
});
