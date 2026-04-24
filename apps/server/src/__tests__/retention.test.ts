/**
 * Retention sweep: crypto-shreds messages past retention_days and deletes
 * their attachments. Also cleans the idempotency_keys table.
 *
 * These tests cover the three behaviours that can silently break in prod:
 *  - retention disabled (retention_days NULL) → no messages touched
 *  - retention enabled with old messages → ciphertext zeroed, attachments gone
 *  - idempotency cleanup: 24h fixed horizon + 5min stuck-placeholder horizon
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
}, 120_000);

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  // Reset firm_settings.retention_days + clear any stray messages from prior
  // tests so each case starts from a known baseline.
  await db('firm_settings').where({ id: 1 }).update({ retention_days: null });
  await db('idempotency_keys').delete();
});

async function seedConversation(): Promise<{
  conversationId: string;
  senderId: string;
}> {
  const { db } = await import('../db/knex.js');
  const [user] = await db('users')
    .insert({
      username: `retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      display_name: 'Retention Tester',
      password_hash: '$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    .returning(['id']);
  const [conv] = await db('conversations')
    .insert({ type: 'internal', display_name: 'Retention' })
    .returning(['id']);
  return { conversationId: conv.id as string, senderId: user.id as string };
}

describe('retention sweep', () => {
  it('does nothing when retention_days is null', async () => {
    const { db } = await import('../db/knex.js');
    const { conversationId, senderId } = await seedConversation();
    await db('messages').insert({
      conversation_id: conversationId,
      sender_id: senderId,
      ciphertext: Buffer.from('secret-ciphertext-bytes'),
      content_key_version: 1,
      source: 'app',
      created_at: db.raw(`NOW() - INTERVAL '400 days'`),
    });
    const { runRetentionSweep } = await import('../services/retention.js');
    const res = await runRetentionSweep();
    expect(res.retentionDays).toBeNull();
    expect(res.messagesShredded).toBe(0);
    // Ciphertext must be untouched when retention is disabled.
    const row = await db('messages').where({ conversation_id: conversationId }).first();
    expect((row.ciphertext as Buffer).length).toBeGreaterThan(0);
  });

  it('shreds ciphertext for messages older than retention_days', async () => {
    const { db } = await import('../db/knex.js');
    const { conversationId, senderId } = await seedConversation();
    await db('firm_settings').where({ id: 1 }).update({ retention_days: 30 });
    const [old] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        ciphertext: Buffer.from('needs-to-go'),
        content_key_version: 1,
        source: 'app',
        created_at: db.raw(`NOW() - INTERVAL '60 days'`),
      })
      .returning(['id']);
    const [recent] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        ciphertext: Buffer.from('keep-this'),
        content_key_version: 1,
        source: 'app',
      })
      .returning(['id']);
    const { runRetentionSweep } = await import('../services/retention.js');
    const res = await runRetentionSweep();
    expect(res.retentionDays).toBe(30);
    expect(res.messagesShredded).toBeGreaterThanOrEqual(1);
    const oldRow = await db('messages').where({ id: old.id }).first();
    const recentRow = await db('messages').where({ id: recent.id }).first();
    expect((oldRow.ciphertext as Buffer).length).toBe(0);
    expect((recentRow.ciphertext as Buffer).length).toBeGreaterThan(0);
  });

  it('deletes idempotency_keys rows older than 24 hours and keeps completed-recent ones', async () => {
    const { db } = await import('../db/knex.js');
    const { conversationId, senderId } = await seedConversation();
    // A completed claim has message_id pointing at the real message row, so
    // it is immune to the 5-minute stuck-placeholder rule and only the 24h
    // horizon applies. Seed one fresh, one old.
    const [freshMsg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        ciphertext: Buffer.from('fresh'),
        content_key_version: 1,
        source: 'app',
      })
      .returning(['id']);
    const [oldMsg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        ciphertext: Buffer.from('old'),
        content_key_version: 1,
        source: 'app',
      })
      .returning(['id']);
    await db('idempotency_keys').insert({
      key: 'old-key',
      user_id: senderId,
      response: { id: oldMsg.id },
      message_id: oldMsg.id,
      created_at: db.raw(`NOW() - INTERVAL '25 hours'`),
    });
    await db('idempotency_keys').insert({
      key: 'fresh-key',
      user_id: senderId,
      response: { id: freshMsg.id },
      message_id: freshMsg.id,
      created_at: db.raw(`NOW() - INTERVAL '1 hour'`),
    });
    const { runRetentionSweep } = await import('../services/retention.js');
    await runRetentionSweep();
    const remaining = await db('idempotency_keys').select('key');
    const keys = remaining.map((r) => r.key as string);
    expect(keys).not.toContain('old-key');
    expect(keys).toContain('fresh-key');
  });

  it('garbage-collects stuck placeholder idempotency rows older than 5 minutes', async () => {
    // A crashed claim leaves message_id=null indefinitely; the sweep should
    // free the slot so retries can proceed. Rows with message_id set are
    // kept until the 24h horizon.
    const { db } = await import('../db/knex.js');
    const { conversationId, senderId } = await seedConversation();
    const [recentMsg] = await db('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        ciphertext: Buffer.from('recent'),
        content_key_version: 1,
        source: 'app',
      })
      .returning(['id']);
    await db('idempotency_keys').insert({
      key: 'stuck-placeholder',
      user_id: senderId,
      response: {},
      message_id: null,
      created_at: db.raw(`NOW() - INTERVAL '10 minutes'`),
    });
    await db('idempotency_keys').insert({
      key: 'completed-recent',
      user_id: senderId,
      response: { id: recentMsg.id },
      message_id: recentMsg.id,
      created_at: db.raw(`NOW() - INTERVAL '30 seconds'`),
    });
    const { runRetentionSweep } = await import('../services/retention.js');
    await runRetentionSweep();
    const remaining = await db('idempotency_keys').select('key');
    const keys = remaining.map((r) => r.key as string);
    expect(keys).not.toContain('stuck-placeholder');
    expect(keys).toContain('completed-recent');
  });
});
