/**
 * Integration tests for the offline-notify pipeline:
 *   - PATCH /auth/me — phone + email self-edit + E.164 normalization
 *   - notifyForNewMessage() fanout: gating on presence, DND, urgency,
 *     fallback prefs, and the absence of a phone for SMS
 *
 * Seeded users (see apps/server/src/db/seeds/01_groups_and_users.js):
 *   alice  / alice-dev-only-ChangeMe!  (non-admin)
 *   bob    / bob-dev-only-ChangeMe!    (non-admin)
 *   kurt   / kurt-dev-only-ChangeMe!   (admin)
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
  // Match the harness pattern from auth.test.ts: leave the pool alone so other
  // test files can reuse the connection without paying re-init costs.
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return agent;
}

async function getMe(agent: TestAgent): Promise<{
  id: string;
  email: string | null;
  phone: string | null;
}> {
  const r = await agent.get('/auth/me');
  expect(r.status).toBe(200);
  return r.body.user;
}

beforeEach(async () => {
  // Wipe per-test state but keep the seed users around so loginAs() works.
  const { db } = await import('../db/knex.js');
  await db('messages').del();
  await db('conversation_members').del();
  await db('conversation_keys').del();
  await db('conversations').del();
  // Reset every staff member's prefs + presence to a known baseline.
  await db('notification_prefs').del();
  await db('user_presence').update({ socket_count: 0 }).whereNotNull('user_id');
  await db('users').update({ phone: null });
});

describe('PATCH /auth/me', () => {
  it('normalizes a NANP-style phone to E.164 and persists it', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.patch('/auth/me').send({ phone: '(555) 123-4567' });
    expect(r.status).toBe(200);
    expect(r.body.user.phone).toBe('+15551234567');
    const me = await getMe(alice);
    expect(me.phone).toBe('+15551234567');
  });

  it('rejects malformed phone with 400', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.patch('/auth/me').send({ phone: 'not-a-number' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_phone');
  });

  it('clears phone when sent as null', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await alice.patch('/auth/me').send({ phone: '+15551234567' });
    const cleared = await alice.patch('/auth/me').send({ phone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.user.phone).toBeNull();
  });

  it('lower-cases email when updated and leaves phone alone', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await alice.patch('/auth/me').send({ phone: '+15551234567' });
    const r = await alice.patch('/auth/me').send({ email: 'Alice@Example.COM' });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('alice@example.com');
    expect(r.body.user.phone).toBe('+15551234567');
  });

  it('writes a user.self_updated audit row with field names but no values', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    await alice.patch('/auth/me').send({ phone: '+15551234567' });
    const { db } = await import('../db/knex.js');
    const row = await db('audit_log')
      .where({ actor_user_id: aliceMe.id, action: 'user.self_updated' })
      .orderBy('created_at', 'desc')
      .first();
    expect(row).toBeTruthy();
    const details = row!.details as { fields?: string[] };
    expect(details.fields).toContain('phone');
    // PII assertion: the raw phone must NOT appear in audit row values.
    expect(JSON.stringify(row)).not.toContain('+15551234567');
  });
});

describe('notifyForNewMessage()', () => {
  // Lightweight conversation builder — sidesteps the E2EE flow tested in
  // conversations.test.ts. We only need a conversation row + 2 members for the
  // fanout to find a recipient.
  async function makeConv(memberUserIds: string[]): Promise<string> {
    const { db } = await import('../db/knex.js');
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: null })
      .returning(['id']);
    for (const uid of memberUserIds) {
      await db('conversation_members').insert({ conversation_id: conv.id, user_id: uid });
    }
    return conv.id as string;
  }

  async function setPrefs(userId: string, patch: Record<string, unknown>): Promise<void> {
    const { db } = await import('../db/knex.js');
    await db('notification_prefs')
      .insert({ user_id: userId, ...patch })
      .onConflict('user_id')
      .merge(patch);
  }

  async function setPhone(userId: string, phone: string | null): Promise<void> {
    const { db } = await import('../db/knex.js');
    await db('users').where({ id: userId }).update({ phone });
  }

  async function setOnline(userId: string, count: number): Promise<void> {
    const { db } = await import('../db/knex.js');
    await db('user_presence')
      .insert({ user_id: userId, socket_count: count })
      .onConflict('user_id')
      .merge({ socket_count: count });
  }

  it('emails an offline recipient with email_fallback_enabled (urgent message)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      email_fallback_enabled: true,
      email_fallback_urgent_only: 1,
      sms_fallback_enabled: false,
      sms_fallback_urgent_only: 1,
    });

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000001',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.userId).toBe(bobMe.id);
    expect(results[0]!.email).toBe('sent');
    expect(results[0]!.sms).toBe('skipped');
  });

  it('skips email + SMS when the recipient is online (sockets > 0)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      email_fallback_enabled: true,
      email_fallback_urgent_only: 0,
      sms_fallback_enabled: true,
      sms_fallback_urgent_only: 0,
    });
    await setPhone(bobMe.id, '+15551234567');
    await setOnline(bobMe.id, 1);

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000002',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: false,
    });
    expect(results[0]!.email).toBe('skipped');
    expect(results[0]!.sms).toBe('skipped');
  });

  it('does not notify the sender about their own message', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const convId = await makeConv([aliceMe.id]); // notes-to-self

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000003',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: true,
    });
    expect(results).toHaveLength(0);
  });

  it('sends SMS when sms_fallback_enabled + phone present + urgent message', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      email_fallback_enabled: false,
      email_fallback_urgent_only: 1,
      sms_fallback_enabled: true,
      sms_fallback_urgent_only: 1,
    });
    await setPhone(bobMe.id, '+15551234567');

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000004',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: true,
    });
    expect(results[0]!.sms).toBe('sent');
    expect(results[0]!.email).toBe('skipped');
  });

  it('skips SMS when phone is missing even though sms_fallback_enabled=true', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      email_fallback_enabled: false,
      email_fallback_urgent_only: 1,
      sms_fallback_enabled: true,
      sms_fallback_urgent_only: 0,
    });
    // Deliberately no setPhone call.

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000005',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: false,
    });
    expect(results[0]!.sms).toBe('skipped');
  });

  it('respects urgent_only=true: a non-urgent message yields no fallback', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      email_fallback_enabled: true,
      email_fallback_urgent_only: 1,
      sms_fallback_enabled: true,
      sms_fallback_urgent_only: 1,
    });
    await setPhone(bobMe.id, '+15551234567');

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000006',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: false,
    });
    expect(results[0]!.email).toBe('skipped');
    expect(results[0]!.sms).toBe('skipped');
  });

  it('DND blocks a non-urgent fallback while urgent_overrides_dnd lets urgent through', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    // 24/7 DND so we don't need to mock the clock.
    await setPrefs(bobMe.id, {
      dnd_enabled: true,
      dnd_start: '00:00',
      dnd_end: '23:59',
      timezone: 'UTC',
      urgent_overrides_dnd: true,
      email_fallback_enabled: true,
      email_fallback_urgent_only: 0,
      sms_fallback_enabled: false,
      sms_fallback_urgent_only: 1,
    });

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const nonUrgent = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000007',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: false,
    });
    expect(nonUrgent[0]!.email).toBe('skipped');

    const urgent = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000008',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: true,
    });
    expect(urgent[0]!.email).toBe('sent');
  });

  it('DND with urgent_overrides_dnd=false silences urgent too', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const bob = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const aliceMe = await getMe(alice);
    const bobMe = await getMe(bob);
    const convId = await makeConv([aliceMe.id, bobMe.id]);
    await setPrefs(bobMe.id, {
      dnd_enabled: true,
      dnd_start: '00:00',
      dnd_end: '23:59',
      timezone: 'UTC',
      urgent_overrides_dnd: false,
      email_fallback_enabled: true,
      email_fallback_urgent_only: 0,
      sms_fallback_enabled: false,
      sms_fallback_urgent_only: 1,
    });

    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: convId,
      messageId: '00000000-0000-0000-0000-000000000009',
      senderUserId: aliceMe.id,
      senderExternalIdentityId: null,
      urgent: true,
    });
    expect(results[0]!.email).toBe('skipped');
  });

  it('isWithinDnd handles overnight wrap-around (20:00 → 08:00)', async () => {
    const { __testing } = await import('../services/offlineNotify.js');
    // 22:00 UTC → inside the 20:00–08:00 window
    const at22 = new Date('2026-04-24T22:00:00Z');
    expect(
      __testing.isWithinDnd(at22, {
        dnd_enabled: true,
        dnd_start: '20:00',
        dnd_end: '08:00',
        timezone: 'UTC',
      }),
    ).toBe(true);
    // 12:00 UTC → outside
    const at12 = new Date('2026-04-24T12:00:00Z');
    expect(
      __testing.isWithinDnd(at12, {
        dnd_enabled: true,
        dnd_start: '20:00',
        dnd_end: '08:00',
        timezone: 'UTC',
      }),
    ).toBe(false);
    // dnd disabled overrides everything
    expect(
      __testing.isWithinDnd(at22, {
        dnd_enabled: false,
        dnd_start: '20:00',
        dnd_end: '08:00',
        timezone: 'UTC',
      }),
    ).toBe(false);
  });

  it('is safe to call when the conversation has no messageable recipients', async () => {
    const { db } = await import('../db/knex.js');
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: null })
      .returning(['id']);
    const { notifyForNewMessage } = await import('../services/offlineNotify.js');
    const results = await notifyForNewMessage({
      conversationId: conv.id,
      messageId: '00000000-0000-0000-0000-00000000000a',
      senderUserId: null,
      senderExternalIdentityId: null,
      urgent: false,
    });
    expect(results).toHaveLength(0);
  });
});
