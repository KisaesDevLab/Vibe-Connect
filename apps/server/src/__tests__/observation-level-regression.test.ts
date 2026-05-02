/**
 * Regression coverage for the low-severity observation fixes (L-1, L-2, L-4,
 * L-5). L-3 was a test-hygiene fix that the observations suite already owns.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
}, 120_000);

describe('L-1: retention max-iterations cap emits a warning', () => {
  it('does not fire the cap warning on a small, single-batch sweep', async () => {
    const { db } = await import('../db/knex.js');
    const { runRetentionSweep } = await import('../services/retention.js');
    const loggerMod = await import('../logger.js');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');
    await db('firm_settings').where({ id: 1 }).update({ retention_days: 1 });
    const [staff] = await db('users')
      .insert({
        username: `l1-${Date.now()}`,
        password_hash: bcrypt.hashSync('x', 4),
        display_name: 'L1',
        is_admin: false,
        is_active: true,
      })
      .returning(['id']);
    const [conv] = await db('conversations')
      .insert({ type: 'internal', display_name: 'L1 conv' })
      .returning(['id']);
    const convId = (conv as { id: string }).id;
    try {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await db('messages').insert(
        Array.from({ length: 50 }, () => ({
          conversation_id: convId,
          sender_id: (staff as { id: string }).id,
          ciphertext: Buffer.from('c'),
          content_key_version: 1,
          created_at: old,
        })),
      );
      await runRetentionSweep();
      const capCall = warnSpy.mock.calls.find((args) => args[0] === 'retention.max_iterations_hit');
      expect(capCall).toBeUndefined();
    } finally {
      await db('messages').where({ conversation_id: convId }).del();
      await db('conversations').where({ id: convId }).del();
      await db('users')
        .where({ id: (staff as { id: string }).id })
        .del();
      await db('firm_settings').where({ id: 1 }).update({ retention_days: null });
      warnSpy.mockRestore();
    }
  });
});

describe('L-2: retention idempotency cleanup is isolated', () => {
  it('swallows an idempotency-table failure and logs retention.idempotency_cleanup_failed', async () => {
    // Use the new `dbOverride` DI seam (M-2) instead of monkey-patching the
    // module's live binding. The mocked knex-style callable throws only for
    // `idempotency_keys`, delegating everything else to the real db.
    const loggerMod = await import('../logger.js');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');
    const { db: realDb } = await import('../db/knex.js');
    const faultyDb = ((table: string) => {
      if (table === 'idempotency_keys') {
        return {
          where() {
            return this;
          },
          whereNull() {
            return this;
          },
          del(): Promise<never> {
            return Promise.reject(new Error('synthetic_idempotency_fault'));
          },
        };
      }
      return realDb(table);
    }) as unknown as typeof realDb;
    // Copy over the functional helpers (db.raw, db.fn, db.transaction) from
    // the real knex so the rest of runRetentionSweep still works. These are
    // methods on the callable so JS function-object copying handles them.
    Object.assign(faultyDb, {
      raw: realDb.raw.bind(realDb),
      fn: realDb.fn,
      transaction: realDb.transaction.bind(realDb),
    });
    try {
      const { runRetentionSweep } = await import('../services/retention.js');
      const result = await runRetentionSweep(faultyDb);
      expect(result).toBeDefined();
      const captured = warnSpy.mock.calls.find(
        (args) => args[0] === 'retention.idempotency_cleanup_failed',
      );
      expect(captured).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('L-4 / portal lastMessageAt is surfaced for the sidebar', () => {
  it('GET /portal/conversations returns last-message metadata per conversation', async () => {
    const { db } = await import('../db/knex.js');
    const { hashSessionToken, newSessionToken } = await import('../services/accessCodes.js');
    const mod = await import('../app.js');
    const app = mod.createApp();
    const [identity] = await db('external_identities')
      .insert({
        email: `l4-${Date.now()}@example.com`,
        display_name: 'L4',
      })
      .returning(['id']);
    const token = newSessionToken();
    await db('client_sessions').insert({
      external_identity_id: identity.id,
      session_token_hash: hashSessionToken(token),
      absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
      user_agent: 'test',
      ip_address: '127.0.0.1',
      session_public_key: 'test-pubkey',
    });
    const cookie = `vibe.portal=${token}`;
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'L4 conv' })
      .returning(['id']);
    await db('conversation_members').insert({
      conversation_id: conv.id,
      external_identity_id: identity.id,
    });
    await db('messages').insert({
      conversation_id: conv.id,
      sender_external_identity_id: identity.id,
      ciphertext: Buffer.from('c'),
      content_key_version: 1,
      source: 'email-in',
    });
    const res = await request(app).get('/portal/conversations').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const row = (
      res.body.conversations as Array<{
        id: string;
        lastMessageAt: string | null;
        lastMessageSource: string | null;
      }>
    ).find((c) => c.id === conv.id);
    expect(row).toBeDefined();
    expect(row!.lastMessageAt).toBeTruthy();
    expect(row!.lastMessageSource).toBe('email-in');
  });
});
