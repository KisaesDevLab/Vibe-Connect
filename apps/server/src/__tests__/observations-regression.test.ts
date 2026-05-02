/**
 * Regression coverage for the observation-level fixes:
 *   Obs #4: retention sweep paginates instead of loading every id at once
 *   Obs #5: X-Request-Id double `ext:` prefix is collapsed
 *   Obs #7: io.close is awaited during shutdown (indirectly verified via
 *           scheduledMessages runOnce retry in batch-abc-regression)
 *   Obs #9: firm_settings PATCH accepts messageEditWindowMinutes and
 *           smsQuietStartHour / smsQuietEndHour
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

describe('Obs #5: X-Request-Id double ext: prefix', () => {
  it('echoes a single ext: prefix regardless of how many the caller sent', async () => {
    const res1 = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    expect(res1.headers['x-request-id']).toBe('ext:abc-123');
    const res2 = await request(app).get('/health').set('X-Request-Id', 'ext:abc-123');
    expect(res2.headers['x-request-id']).toBe('ext:abc-123');
    // The malformed form with the prefix but an invalid tail after strip
    // (e.g. too long or bad chars) falls back to a server-minted 8-hex id.
    const res3 = await request(app).get('/health').set('X-Request-Id', 'ext:bad chars!');
    expect(res3.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Obs #4: retention sweep paginates', () => {
  it('processes more than one batch and shreds them all', async () => {
    const { db } = await import('../db/knex.js');
    const { runRetentionSweep } = await import('../services/retention.js');
    // Seed a firm-settings retention policy shorter than the created_at of
    // the messages we're about to insert, so everything qualifies.
    await db('firm_settings').where({ id: 1 }).update({ retention_days: 1 });
    const [staff] = await db('users')
      .insert({
        username: `ret-${Date.now()}`,
        password_hash: bcrypt.hashSync('x', 4),
        display_name: 'Ret',
        is_admin: false,
        is_active: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: 'Ret' })
      .returning(['id']);
    const convId = (conv as { id: string }).id;
    try {
      // Insert more than one BATCH_SIZE (100) messages so we exercise the loop.
      // The retention query filters on created_at < cutoff (1 day ago); insert
      // with explicit old created_at so the filter catches them.
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const rows = Array.from({ length: 205 }, () => ({
        conversation_id: convId,
        sender_id: (staff as { id: string }).id,
        ciphertext: Buffer.from('c'),
        content_key_version: 1,
        created_at: old,
      }));
      // Chunk the insert — single insert() with 205 rows is fine for pg but
      // some knex versions have arg-count ceilings in their chained builder.
      for (let i = 0; i < rows.length; i += 50) {
        await db('messages').insert(rows.slice(i, i + 50));
      }
      const result = await runRetentionSweep();
      expect(result.messagesShredded).toBeGreaterThanOrEqual(205);
      // After the sweep every one of those rows has empty ciphertext.
      const remainingWithBytes = await db('messages')
        .where({ conversation_id: convId })
        .andWhereRaw('octet_length(ciphertext) > 0')
        .count<{ count: string }[]>('* as count');
      expect(Number(remainingWithBytes[0]!.count)).toBe(0);
    } finally {
      // Tidy up: delete the seed rows + the conversation + the staff user so
      // they don't accumulate in the shared test DB and skew later suites'
      // count assertions. Retention policy goes back to null too.
      await db('messages').where({ conversation_id: convId }).del();
      await db('conversations').where({ id: convId }).del();
      await db('users')
        .where({ id: (staff as { id: string }).id })
        .del();
      await db('firm_settings').where({ id: 1 }).update({ retention_days: null });
    }
  });
});

describe('Obs #9: firm settings accepts new fields', () => {
  it('PATCH /admin/settings persists messageEditWindowMinutes + SMS quiet hours', async () => {
    const { db } = await import('../db/knex.js');
    const username = `settings-${Date.now()}`;
    const pw = 'long-test-password-ok';
    await db('users').insert({
      username,
      password_hash: bcrypt.hashSync(pw, 4),
      display_name: 'SettingsAdmin',
      is_admin: true,
      is_active: true,
    });
    const agent = request.agent(app);
    const login = await agent.post('/auth/login').send({ username, password: pw });
    expect(login.status).toBe(200);
    const patch = await agent.patch('/admin/settings').send({
      messageEditWindowMinutes: 30,
      smsQuietStartHour: 22,
      smsQuietEndHour: 6,
    });
    expect(patch.status).toBe(200);
    const get = await agent.get('/admin/settings');
    expect(get.status).toBe(200);
    expect(get.body.settings.message_edit_window_minutes).toBe(30);
    expect(get.body.settings.sms_quiet_start_hour).toBe(22);
    expect(get.body.settings.sms_quiet_end_hour).toBe(6);
    // Restore defaults so downstream tests aren't affected.
    await db('firm_settings').where({ id: 1 }).update({
      message_edit_window_minutes: 15,
      sms_quiet_start_hour: 8,
      sms_quiet_end_hour: 21,
    });
  });

  it('rejects invalid hour values', async () => {
    const { db } = await import('../db/knex.js');
    const username = `settings-hours-${Date.now()}`;
    const pw = 'long-test-password-ok';
    await db('users').insert({
      username,
      password_hash: bcrypt.hashSync(pw, 4),
      display_name: 'SettingsAdmin',
      is_admin: true,
      is_active: true,
    });
    const agent = request.agent(app);
    await agent.post('/auth/login').send({ username, password: pw });
    const bad = await agent.patch('/admin/settings').send({ smsQuietStartHour: 25 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_request');
  });
});
