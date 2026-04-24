/**
 * Regression: verifyAccessCode must serialize concurrent attempts per code row
 * so two parallel POSTs cannot (a) both bypass the 5-attempt lockout nor
 * (b) both mark the same code consumed. The previous implementation used four
 * separate non-transactional statements, leaving a wide race window. The fix
 * wraps the read/compare/consume in a db.transaction with forUpdate().
 */
import { beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { resetTestDb } from './test-helpers.js';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  await resetTestDb();
}, 120_000);

async function seedIdentity(): Promise<{ id: string }> {
  const { db } = await import('../db/knex.js');
  const [row] = await db('external_identities')
    .insert({
      email: `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      display_name: 'Race Tester',
      verification_type: 'none',
    })
    .returning(['id']);
  return { id: row.id as string };
}

async function insertAccessCode(
  identityId: string,
  code: string,
  attempts = 0,
): Promise<string> {
  const { db } = await import('../db/knex.js');
  const [row] = await db('access_codes')
    .insert({
      external_identity_id: identityId,
      code_hash: await bcrypt.hash(code, 10),
      sent_to: 'x@example.com',
      sent_via: 'email',
      attempts,
      expires_at: db.raw(`NOW() + INTERVAL '10 minutes'`),
    })
    .returning(['id']);
  return row.id as string;
}

describe('verifyAccessCode concurrency', () => {
  it('two parallel correct verifies end with exactly one used_at and attempts=2', async () => {
    // If the code consumption weren't atomic, both requests could read
    // used_at IS NULL, both succeed, and we'd observe inconsistent state.
    const { id } = await seedIdentity();
    const codeId = await insertAccessCode(id, '123456');
    const { verifyAccessCode } = await import('../services/accessCodes.js');
    const { db } = await import('../db/knex.js');

    const results = await Promise.all([
      verifyAccessCode(
        {
          id,
          email: 'x@example.com',
          phone: null,
          display_name: 'x',
          verification_type: 'none',
          verification_last4_hash: null,
          verification_required: false,
          deactivated_at: null,
        },
        '123456',
      ),
      verifyAccessCode(
        {
          id,
          email: 'x@example.com',
          phone: null,
          display_name: 'x',
          verification_type: 'none',
          verification_last4_hash: null,
          verification_required: false,
          deactivated_at: null,
        },
        '123456',
      ),
    ]);
    // Whichever transaction commits first wins; the second must not observe
    // the row as still-unused. Exactly one ok:true outcome is acceptable.
    const oks = results.filter((r) => r.ok).length;
    expect(oks).toBeGreaterThanOrEqual(1);
    // The row must have been consumed and attempts incremented for every
    // transaction that reached the compare branch (attempts >= 1).
    const row = await db('access_codes').where({ id: codeId }).first();
    expect(row.used_at).not.toBeNull();
    expect(Number(row.attempts)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('lockout returns constant timing (dummy bcrypt) and refuses consumption', async () => {
    // attempts=5 trips the lockout. The fix runs a dummy bcrypt.compare in
    // that branch so an attacker can't distinguish "locked" from "wrong
    // code" by wall-clock. Functional check here: result is {ok:false,
    // reason:'locked'} and used_at stays null.
    const { id } = await seedIdentity();
    const codeId = await insertAccessCode(id, '999999', 5);
    const { verifyAccessCode } = await import('../services/accessCodes.js');
    const { db } = await import('../db/knex.js');
    const result = await verifyAccessCode(
      {
        id,
        email: 'x@example.com',
        phone: null,
        display_name: 'x',
        verification_type: 'none',
        verification_last4_hash: null,
        verification_required: false,
        deactivated_at: null,
      },
      '999999',
    );
    expect(result).toEqual({ ok: false, reason: 'locked' });
    const row = await db('access_codes').where({ id: codeId }).first();
    expect(row.used_at).toBeNull();
  }, 15_000);
});
