/**
 * Batch-1 QA regressions:
 *  - portal POST /portal/conversations/:id/messages (issue #1 — was missing entirely)
 *  - portalUpload message_id ownership check (issue #2 — was missing)
 *  - one-click unsubscribe POST handler (issue #4 — was 404)
 *  - phone normalization on admin-create + inbound SMS lookup (issue #5)
 *  - inbound SMS / email replay-dedup (issue #16; partial in Batch 1)
 *  - scheduled-message ticker dedup (issue #6)
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
  const mod = await import('../app.js');
  app = mod.createApp();
}, 120_000);

async function seedClientAndSession(): Promise<{
  identityId: string;
  cookie: string;
}> {
  const { db } = await import('../db/knex.js');
  const { hashSessionToken, newSessionToken } = await import('../services/accessCodes.js');
  const [row] = await db('external_identities')
    .insert({
      email: `batch1-${Date.now()}-${Math.random().toString(16).slice(2, 6)}@example.com`,
      display_name: 'Batch1 Tester',
      verification_type: 'none',
      verification_required: false,
    })
    .returning(['id']);
  const token = newSessionToken();
  await db('client_sessions').insert({
    external_identity_id: row.id as string,
    session_token_hash: hashSessionToken(token),
    absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    user_agent: 'test',
    ip_address: '127.0.0.1',
    session_public_key: 'test-pubkey',
  });
  return { identityId: row.id as string, cookie: `vibe.portal=${token}` };
}

describe('batch 1 regressions', () => {
  it('POST /portal/conversations/:id/messages stores ciphertext + audits', async () => {
    const { db } = await import('../db/knex.js');
    const { identityId, cookie } = await seedClientAndSession();
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'Portal POST test' })
      .returning(['id']);
    const convId = (conv as { id: string }).id;
    await db('conversation_members').insert({
      conversation_id: convId,
      external_identity_id: identityId,
    });
    const ciphertext = Buffer.from(JSON.stringify({ n: 'aa', c: 'bb', v: 1 })).toString('base64');
    const r = await request(app)
      .post(`/portal/conversations/${convId}/messages`)
      .set('Cookie', cookie)
      .send({ ciphertext, contentKeyVersion: 1, ciphertextMeta: {} });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    const row = await db('messages').where({ id: r.body.id }).first();
    expect(row).toBeTruthy();
    expect(row.sender_external_identity_id).toBe(identityId);
    expect(row.source).toBe('app');
    const audit = await db('audit_log')
      .where({ action: 'portal.message_sent', target_id: r.body.id })
      .first();
    expect(audit).toBeTruthy();
  });

  it('POST /portal/conversations/:id/messages refuses non-members', async () => {
    const { db } = await import('../db/knex.js');
    const { cookie } = await seedClientAndSession();
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'Not-a-member test' })
      .returning(['id']);
    const r = await request(app)
      .post(`/portal/conversations/${(conv as { id: string }).id}/messages`)
      .set('Cookie', cookie)
      .send({ ciphertext: 'eyJuIjoiYSIsImMiOiJiIiwidiI6MX0=', contentKeyVersion: 1 });
    expect(r.status).toBe(404);
  });

  it('POST /portal/conversations/:id/messages refuses internal_thread', async () => {
    const { db } = await import('../db/knex.js');
    const { identityId, cookie } = await seedClientAndSession();
    const [parent] = await db('conversations')
      .insert({ type: 'external', display_name: 'Parent ext' })
      .returning(['id']);
    const [thread] = await db('conversations')
      .insert({
        type: 'internal_thread',
        parent_conversation_id: (parent as { id: string }).id,
      })
      .returning(['id']);
    // Wrongly add the client to the thread (membership insert isn't blocked at
    // the column level — only the route refuses).
    await db('conversation_members').insert({
      conversation_id: (thread as { id: string }).id,
      external_identity_id: identityId,
    });
    const r = await request(app)
      .post(`/portal/conversations/${(thread as { id: string }).id}/messages`)
      .set('Cookie', cookie)
      .send({ ciphertext: 'eyJuIjoiYSIsImMiOiJiIiwidiI6MX0=', contentKeyVersion: 1 });
    expect(r.status).toBe(404);
  });

  it('POST /bridges/unsubscribe (one-click) marks identity unsubscribed', async () => {
    const { db } = await import('../db/knex.js');
    const { signUnsubscribeToken } = await import('../bridges/unsubscribeTokens.js');
    const [row] = await db('external_identities')
      .insert({
        email: `unsub-${Date.now()}@example.com`,
        display_name: 'Unsub Tester',
        verification_type: 'none',
      })
      .returning(['id']);
    const t = await signUnsubscribeToken(row.id as string);
    const r = await request(app)
      .post(`/bridges/unsubscribe?t=${encodeURIComponent(t)}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click');
    expect(r.status).toBe(200);
    const after = await db('external_identities').where({ id: row.id }).first();
    expect(after.preferences?.emailUnsubscribed).toBe(true);
    const audit = await db('audit_log')
      .where({
        action: 'email.unsubscribed',
        actor_external_identity_id: row.id,
      })
      .first();
    expect(audit).toBeTruthy();
    expect(audit.details?.method).toBe('POST');
  });

  it('GET /bridges/unsubscribe still works (browser click)', async () => {
    const { db } = await import('../db/knex.js');
    const { signUnsubscribeToken } = await import('../bridges/unsubscribeTokens.js');
    const [row] = await db('external_identities')
      .insert({
        email: `unsub-get-${Date.now()}@example.com`,
        display_name: 'Unsub Get Tester',
      })
      .returning(['id']);
    const t = await signUnsubscribeToken(row.id as string);
    const r = await request(app).get(`/bridges/unsubscribe?t=${encodeURIComponent(t)}`);
    expect(r.status).toBe(200);
    const after = await db('external_identities').where({ id: row.id }).first();
    expect(after.preferences?.emailUnsubscribed).toBe(true);
  });

  it('normalizePhone canonicalises NANP variants to a single string', async () => {
    const { normalizePhone } = await import('../services/accessCodes.js');
    expect(normalizePhone('5551234567')).toBe('+15551234567');
    expect(normalizePhone('15551234567')).toBe('+15551234567');
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('555-123-4567')).toBe('+15551234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('123')).toBeNull();
  });

  it('scheduled message ticker emits exactly once per scheduled row', async () => {
    const { db } = await import('../db/knex.js');
    const { runOnce, setScheduledBroadcaster } = await import('../services/scheduledMessages.js');
    // Set up a conversation + scheduled-but-elapsed message. We need a real
    // staff user to satisfy chk_message_sender (sender_id NOT NULL when
    // sender_external_identity_id IS NULL).
    const [staff] = await db('users')
      .insert({
        username: `sched-dedup-${Date.now()}`,
        password_hash: bcrypt.hashSync('dummy', 4),
        display_name: 'Sched Sender',
        is_admin: false,
        is_active: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: 'Sched dedup' })
      .returning(['id']);
    const convId = (conv as { id: string }).id;
    const [msg] = await db('messages')
      .insert({
        conversation_id: convId,
        sender_id: (staff as { id: string }).id,
        ciphertext: Buffer.from('cipher'),
        content_key_version: 1,
        scheduled_for: new Date(Date.now() - 5_000).toISOString(),
      })
      .returning(['id']);
    const broadcasts: Array<{ id: string; conversationId: string }> = [];
    setScheduledBroadcaster({
      broadcastMessageVisible: (m) => {
        broadcasts.push(m);
      },
    });
    // Three back-to-back ticks. Pre-fix: each tick re-broadcast the row → 3
    // events. Post-fix: the first claim sets scheduled_broadcast_at; the
    // following ticks see no pending rows.
    const n1 = await runOnce();
    const n2 = await runOnce();
    const n3 = await runOnce();
    expect(n1).toBe(1);
    expect(n2).toBe(0);
    expect(n3).toBe(0);
    expect(broadcasts.filter((b) => b.id === (msg as { id: string }).id).length).toBe(1);
  });
});
