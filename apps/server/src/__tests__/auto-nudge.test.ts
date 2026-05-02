/**
 * Phase 24.7 — nudges + auto-cadence.
 *
 * Covers the manual nudge endpoint, the rate-limit, the scheduled-message
 * ticker's skip-on-complete logic, and the auto-nudge sweeper's offset
 * math + idempotency check.
 *
 * The scheduled-message ticker is exercised directly via runOnce() so the
 * tests don't have to wait for the 15s interval.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { resetTestDb } from './test-helpers.js';

let app: Express;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

afterAll(async () => {
  // Pool stays open per harness convention.
});

interface SeedUserIds {
  kurt: string;
  alice: string;
  bob: string;
}
let userIds: SeedUserIds;
let conversationId: string;

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('request_items').del();
  await db('request_lists').del();
  await db('request_templates').del();
  await db('audit_log').del();
  await db('attachments').del();
  await db('messages').del();
  await db('conversation_members').del();
  await db('conversation_keys').del();
  await db('conversations').del();
  // Reset firm-level auto-nudge state per test so a leftover ON state from
  // an earlier test doesn't mask a later check.
  await db('firm_settings')
    .where({ id: 1 })
    .update({
      auto_nudge_enabled: false,
      auto_nudge_offsets_hours: [72, 24, 0],
    });
  const rows = await db('users')
    .whereIn('username', ['kurt', 'alice', 'bob'])
    .select('id', 'username');
  userIds = Object.fromEntries(rows.map((r) => [r.username, r.id])) as SeedUserIds;
  const [conv] = await db('conversations').insert({ type: 'internal' }).returning(['id']);
  conversationId = conv.id;
  await db('conversation_members').insert([
    { conversation_id: conversationId, user_id: userIds.alice },
    { conversation_id: conversationId, user_id: userIds.bob },
  ]);
  await db('conversation_keys').insert({
    conversation_id: conversationId,
    rotation_version: 1,
    wrapped_keys: JSON.stringify({}),
  });
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return agent;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

async function makeListDueIn(daysFromNow: number): Promise<string> {
  const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
  const due = new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
  const created = await alice.post(`/conversations/${conversationId}/request-lists`).send({
    title: 'Test list',
    dueDate: due,
    items: [
      { titleCiphertext: b64('one'), contentKeyVersion: 1, responseType: 'text' },
      { titleCiphertext: b64('two'), contentKeyVersion: 1, responseType: 'text' },
    ],
  });
  if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
  return created.body.list.id;
}

describe('POST /request-lists/:id/nudge (manual)', () => {
  it('enqueues a system message + audit row', async () => {
    const listId = await makeListDueIn(7);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all' });
    expect(r.status).toBe(202);
    expect(r.body.messageId).toEqual(expect.any(String));
    const { db } = await import('../db/knex.js');
    const msg = await db('messages').where({ id: r.body.messageId }).first();
    expect(msg).toBeTruthy();
    expect(msg!.source).toBe('system');
    expect((msg!.ciphertext_meta as Record<string, unknown>).systemEventType).toBe(
      'request_nudge_sent',
    );
    const audits = await db('audit_log')
      .where({ target_id: listId, action: 'request.nudge_scheduled' })
      .select('action');
    expect(audits.length).toBe(1);
  });

  it('rate-limits to 3 nudges per list per 24h', async () => {
    const listId = await makeListDueIn(7);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    for (let i = 0; i < 3; i++) {
      const r = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all' });
      expect(r.status).toBe(202);
    }
    const blocked = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
  });

  it('refuses non-members', async () => {
    const listId = await makeListDueIn(7);
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.post(`/request-lists/${listId}/nudge`).send({ channel: 'all' });
    expect(r.status).toBe(403);
  });

  it('refuses to nudge a cancelled list', async () => {
    const listId = await makeListDueIn(7);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await alice.delete(`/request-lists/${listId}`);
    const r = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all' });
    expect(r.status).toBe(409);
  });
});

describe('scheduled-message ticker skip-on-complete', () => {
  it('soft-deletes a queued nudge whose list has completed before the broadcast window', async () => {
    const listId = await makeListDueIn(7);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    // Schedule a nudge for "now + 30s".
    const sendAt = new Date(Date.now() + 30_000).toISOString();
    const enq = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all', sendAt });
    expect(enq.status).toBe(202);
    const messageId: string = enq.body.messageId;

    const { db } = await import('../db/knex.js');
    // Cancel the list — the nudge should be skipped at fire time.
    await db('request_lists').where({ id: listId }).update({ status: 'cancelled' });
    // Force the message past its scheduled_for so the ticker considers it.
    await db('messages')
      .where({ id: messageId })
      .update({ scheduled_for: new Date(Date.now() - 1000).toISOString() });

    const sched = await import('../services/scheduledMessages.js');
    sched.setScheduledBroadcaster({
      broadcastMessageVisible: async () => undefined,
    });
    await sched.runOnce();

    const after = await db('messages').where({ id: messageId }).first();
    expect(after?.deleted_at).not.toBeNull();
    const audits = await db('audit_log').where({ target_id: listId }).select('action');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('request.nudge_skipped');
    expect(actions).not.toContain('request.nudge_sent');
  });

  it('broadcasts + writes nudge_sent audit when list still has pending work', async () => {
    const listId = await makeListDueIn(7);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const sendAt = new Date(Date.now() - 1000).toISOString();
    const enq = await alice.post(`/request-lists/${listId}/nudge`).send({ channel: 'all', sendAt });
    expect(enq.status).toBe(202);

    const sched = await import('../services/scheduledMessages.js');
    let broadcastCount = 0;
    sched.setScheduledBroadcaster({
      broadcastMessageVisible: async () => {
        broadcastCount++;
      },
    });
    await sched.runOnce();
    expect(broadcastCount).toBeGreaterThan(0);

    const { db } = await import('../db/knex.js');
    const audits = await db('audit_log').where({ target_id: listId }).select('action');
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('request.nudge_scheduled');
    expect(actions).toContain('request.nudge_sent');
  });
});

describe('auto-nudge sweeper', () => {
  it('is a no-op when auto_nudge_enabled = false', async () => {
    const { db } = await import('../db/knex.js');
    await makeListDueIn(3); // due in 72h — would match the 72-offset
    await db('firm_settings').where({ id: 1 }).update({ auto_nudge_enabled: false });
    const auto = await import('../services/autoNudge.js');
    const enqueued = await auto.runAutoNudgeOnce(new Date());
    expect(enqueued).toBe(0);
  });

  it('enqueues one nudge per active list per matching offset, idempotently', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings')
      .where({ id: 1 })
      .update({
        auto_nudge_enabled: true,
        auto_nudge_offsets_hours: [72],
      });
    const listId = await makeListDueIn(3);
    // Pin the sweeper's "now" to 72h before due, on the hour boundary.
    const dueRow = await db('request_lists').where({ id: listId }).first('due_date');
    const dueRaw = dueRow!.due_date as string | Date;
    const dueDate =
      dueRaw instanceof Date
        ? new Date(Date.UTC(dueRaw.getUTCFullYear(), dueRaw.getUTCMonth(), dueRaw.getUTCDate()))
        : new Date(`${(dueRaw as string).slice(0, 10)}T00:00:00Z`);
    const now = new Date(dueDate.getTime() - 72 * 60 * 60 * 1000);

    const auto = await import('../services/autoNudge.js');
    const first = await auto.runAutoNudgeOnce(now);
    expect(first).toBe(1);
    // Second run in the same hour must be idempotent.
    const second = await auto.runAutoNudgeOnce(now);
    expect(second).toBe(0);

    // The enqueued nudge carries autoOffsetHours=72 in metadata.
    const msgs = await db('messages')
      .where({ conversation_id: conversationId, source: 'system' })
      .select('ciphertext_meta');
    const found = msgs.find(
      (m) => (m.ciphertext_meta as { autoOffsetHours?: number }).autoOffsetHours === 72,
    );
    expect(found).toBeTruthy();
  });

  it('notifyExternalRecipients dispatches to email + SMS based on stored prefs', async () => {
    const { db } = await import('../db/knex.js');
    // Build a fresh external conversation with a client whose prefs say:
    // email_notifications=true, sms_notifications=true.
    const [extConv] = await db('conversations').insert({ type: 'external' }).returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `client-${Date.now()}@cfhcpa.test`,
        phone: '+15555550100',
        display_name: 'Test Client',
        verification_type: 'none',
        verification_required: false,
        preferences: JSON.stringify({
          email_notifications: true,
          sms_notifications: true,
        }),
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    const offline = await import('../services/offlineNotify.js');
    const results = await offline.notifyExternalRecipients({
      conversationId: extConv.id,
      subject: 'Test reminder',
      shortBody: 'Items pending',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.email).toBe('sent');
    expect(results[0]!.sms).toBe('sent');
  });

  it('notifyExternalRecipients respects opt-out flags', async () => {
    const { db } = await import('../db/knex.js');
    const [extConv] = await db('conversations').insert({ type: 'external' }).returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `noemail-${Date.now()}@cfhcpa.test`,
        phone: '+15555550101',
        display_name: 'Opted Out',
        verification_type: 'none',
        verification_required: false,
        preferences: JSON.stringify({
          email_notifications: false,
          sms_notifications: false,
        }),
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    const offline = await import('../services/offlineNotify.js');
    const results = await offline.notifyExternalRecipients({
      conversationId: extConv.id,
      subject: 'Test',
      shortBody: 'Test',
    });
    expect(results[0]!.email).toBe('skipped');
    expect(results[0]!.sms).toBe('skipped');
  });

  it('notifyExternalRecipients treats placeholder emails (no-email-XXX@placeholder.invalid) as no email', async () => {
    const { db } = await import('../db/knex.js');
    const [extConv] = await db('conversations').insert({ type: 'external' }).returning(['id']);
    const [identity] = await db('external_identities')
      .insert({
        email: `no-email-test-${Date.now()}@placeholder.invalid`,
        phone: '+15555550102',
        display_name: 'SMS Only',
        verification_type: 'none',
        verification_required: false,
        preferences: JSON.stringify({
          email_notifications: true,
          sms_notifications: true,
        }),
      })
      .returning(['id']);
    await db('conversation_members').insert([
      { conversation_id: extConv.id, user_id: userIds.alice },
      { conversation_id: extConv.id, external_identity_id: identity.id },
    ]);
    const offline = await import('../services/offlineNotify.js');
    const results = await offline.notifyExternalRecipients({
      conversationId: extConv.id,
      subject: 'Test',
      shortBody: 'Test',
    });
    // Placeholder email is treated as no email; only SMS sends.
    expect(results[0]!.email).toBe('skipped');
    expect(results[0]!.sms).toBe('sent');
  });

  it('skips lists that aren’t active', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings')
      .where({ id: 1 })
      .update({
        auto_nudge_enabled: true,
        auto_nudge_offsets_hours: [72],
      });
    const listId = await makeListDueIn(3);
    await db('request_lists').where({ id: listId }).update({ status: 'cancelled' });
    const auto = await import('../services/autoNudge.js');
    const enqueued = await auto.runAutoNudgeOnce(new Date());
    expect(enqueued).toBe(0);
  });
});
