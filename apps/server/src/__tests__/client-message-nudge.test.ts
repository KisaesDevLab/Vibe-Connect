/**
 * Phase 0.4.33 — client-message nudge ticker.
 *
 * Covers the claim semantics (atomic UPDATE + nudge_sent_at stamp,
 * 15-minute threshold, staff-only sender, app-source only) and the
 * notifyExternalRecipients `excludeReadOfMessageId` filter that
 * strips clients who already read the message in time.
 *
 * We don't exercise the actual email/SMS dispatch here — that's
 * covered in offline-notify.test.ts via the mock providers in
 * .outbox/. These tests assert ONLY the claim + the per-recipient
 * read-receipt filter, which is what the ticker actually owns.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
});

beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  // Each test starts with a clean nudge-relevant slate. We don't
  // truncate firm_settings or users — the seeded admin (kurt) +
  // staff (alice) rows are used by the helpers below.
  await db('read_receipts').del();
  await db('messages').del();
  await db('conversation_members').del();
  await db('external_identities').del();
  await db('conversations').del();
  // Ensure messaging is on for the dispatch path (the ticker short-
  // circuits when client_messaging_enabled is false).
  await db('firm_settings').where({ id: 1 }).update({ client_messaging_enabled: true });
});

async function seedClient(displayName: string, email: string): Promise<string> {
  const { db } = await import('../db/knex.js');
  const [row] = await db('external_identities')
    .insert({
      display_name: displayName,
      email,
      phone: null,
      verification_type: 'none',
      verification_required: false,
      invite_token_hash: 'placeholder-not-real-hash',
      invite_public_key: 'placeholder',
      preferences: { email_notifications: true, sms_notifications: false },
    })
    .returning(['id']);
  return row.id as string;
}

async function seedConvWithStaffAndClient(externalIdentityId: string): Promise<string> {
  const { db } = await import('../db/knex.js');
  const [conv] = await db('conversations')
    .insert({ type: 'external', display_name: null })
    .returning(['id']);
  // Add the staff sender so the conversation_members FK is satisfied.
  const staff = await db('users').where({ username: 'kurt' }).first();
  await db('conversation_members').insert({
    conversation_id: conv.id,
    user_id: staff!.id,
  });
  await db('conversation_members').insert({
    conversation_id: conv.id,
    external_identity_id: externalIdentityId,
  });
  return conv.id as string;
}

async function seedStaffMessage(
  conversationId: string,
  ageMinutes: number,
): Promise<{ id: string; senderId: string }> {
  const { db } = await import('../db/knex.js');
  const staff = await db('users').where({ username: 'kurt' }).first();
  // Insert with a backdated created_at so we don't need to fake-time
  // the test. The ticker query is `created_at <= NOW() - INTERVAL`
  // — pre-aging the row puts us safely past the threshold.
  const [row] = await db('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: staff!.id,
      ciphertext: 'fake-ciphertext-base64',
      content_key_version: 1,
      urgent: false,
      source: 'app',
      created_at: db.raw(`NOW() - INTERVAL '${ageMinutes} minutes'`),
    })
    .returning(['id']);
  return { id: row.id as string, senderId: staff!.id };
}

describe('clientMessageNudgeTicker.runOnce()', () => {
  it('claims a 20-min-old unread staff message and stamps nudge_sent_at', async () => {
    const extId = await seedClient('Pending Reader', 'pending-reader@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 20);

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    const claimed = await runOnce();
    expect(claimed).toBe(1);

    const { db } = await import('../db/knex.js');
    const after = await db('messages').where({ id: msg.id }).first();
    expect(after.nudge_sent_at).not.toBeNull();
  });

  it('skips a 5-min-old message (still under the 15-min threshold)', async () => {
    const extId = await seedClient('Too Soon', 'too-soon@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 5);

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    const claimed = await runOnce();
    expect(claimed).toBe(0);

    const { db } = await import('../db/knex.js');
    const after = await db('messages').where({ id: msg.id }).first();
    expect(after.nudge_sent_at).toBeNull();
  });

  it('runs the claim again only on new messages — nudge_sent_at sticks', async () => {
    const extId = await seedClient('One Shot', 'one-shot@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    await seedStaffMessage(convId, 20);

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    expect(await runOnce()).toBe(1);
    // Second tick: same row already stamped, nothing new to claim.
    expect(await runOnce()).toBe(0);
  });

  it('does not claim a portal-originated message (sender_id IS NULL, sender_external_identity_id set)', async () => {
    const extId = await seedClient('Client Sender', 'client-sender@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const { db } = await import('../db/knex.js');
    await db('messages').insert({
      conversation_id: convId,
      // No sender_id — this is a portal-originated message. The
      // messages-table CHECK constraint requires exactly one of
      // sender_id / sender_external_identity_id, so we set the latter.
      sender_external_identity_id: extId,
      ciphertext: 'fake-ciphertext-base64',
      content_key_version: 1,
      urgent: false,
      source: 'app',
      created_at: db.raw(`NOW() - INTERVAL '20 minutes'`),
    });

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    expect(await runOnce()).toBe(0);
  });

  it('does not claim a bridged-in message (source != app)', async () => {
    const extId = await seedClient('Bridged In', 'bridged-in@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const { db } = await import('../db/knex.js');
    const staff = await db('users').where({ username: 'kurt' }).first();
    await db('messages').insert({
      conversation_id: convId,
      sender_id: staff!.id,
      ciphertext: 'fake-ciphertext-base64',
      content_key_version: 0,
      urgent: false,
      source: 'email-in',
      created_at: db.raw(`NOW() - INTERVAL '20 minutes'`),
    });

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    expect(await runOnce()).toBe(0);
  });

  it('does not claim a tombstoned message (deleted_at set)', async () => {
    const extId = await seedClient('Tombstone', 'tombstone@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 20);
    const { db } = await import('../db/knex.js');
    await db('messages').where({ id: msg.id }).update({ deleted_at: db.fn.now() });

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    expect(await runOnce()).toBe(0);
  });

  it('short-circuits dispatch when client_messaging_enabled is false but still stamps the claim', async () => {
    // Stamping while messaging is off prevents the row from being re-
    // attempted forever once the kill switch flips back on (the user
    // might never read the original message; we shouldn't keep
    // accumulating).
    const extId = await seedClient('Disabled', 'disabled@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 20);

    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ client_messaging_enabled: false });

    const { runOnce } = await import('../services/clientMessageNudgeTicker.js');
    expect(await runOnce()).toBe(1);

    const after = await db('messages').where({ id: msg.id }).first();
    expect(after.nudge_sent_at).not.toBeNull();
  });
});

describe('notifyExternalRecipients excludeReadOfMessageId filter', () => {
  it('skips a recipient who has a read_receipt for the message', async () => {
    const extId = await seedClient('Reader', 'reader@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 1);
    const { db } = await import('../db/knex.js');
    await db('read_receipts').insert({
      message_id: msg.id,
      external_identity_id: extId,
    });

    const { notifyExternalRecipients } = await import('../services/offlineNotify.js');
    const results = await notifyExternalRecipients({
      conversationId: convId,
      subject: 'Test',
      shortBody: 'Test body',
      excludeReadOfMessageId: msg.id,
    });
    // Only recipient is the one who read it → nobody to notify.
    expect(results).toHaveLength(0);
  });

  it('still notifies a recipient who has not read the message', async () => {
    const extId = await seedClient('Unread', 'unread@test.com');
    const convId = await seedConvWithStaffAndClient(extId);
    const msg = await seedStaffMessage(convId, 1);
    // No read_receipt for this recipient on this message.

    const { notifyExternalRecipients } = await import('../services/offlineNotify.js');
    const results = await notifyExternalRecipients({
      conversationId: convId,
      subject: 'Test',
      shortBody: 'Test body',
      excludeReadOfMessageId: msg.id,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.externalIdentityId).toBe(extId);
    // Mock email provider always reports sent; this assertion just
    // confirms the dispatch path actually ran (not skipped pre-flight).
    expect(results[0]!.email).toBe('sent');
  });
});

afterAll(async () => {
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
