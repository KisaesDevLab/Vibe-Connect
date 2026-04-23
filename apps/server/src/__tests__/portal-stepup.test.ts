/**
 * STEPUP regression: the portal step-up endpoint must (a) count attempts in a dedicated
 * column, and (b) revoke the session on the 3rd consecutive failure. A prior implementation
 * stashed attempts in a varchar(255) user_agent column that was never read back, so the
 * "3-strikes → revoke" gate never fired and an attacker could brute-force SSN/EIN last-4.
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

async function seedVerifiedClient(): Promise<{ identityId: string }> {
  const { db } = await import('../db/knex.js');
  const last4Hash = bcrypt.hashSync('1234', 10);
  const [row] = await db('external_identities')
    .insert({
      email: `stepup-${Date.now()}@example.com`,
      display_name: 'Step Up Tester',
      verification_type: 'ssn',
      verification_last4_hash: last4Hash,
      verification_required: true,
    })
    .returning(['id']);
  return { identityId: row.id as string };
}

async function issueSessionTokenFor(identityId: string): Promise<string> {
  const { db } = await import('../db/knex.js');
  const { hashSessionToken, newSessionToken } = await import('../services/accessCodes.js');
  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  await db('client_sessions').insert({
    external_identity_id: identityId,
    session_token_hash: tokenHash,
    absolute_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    user_agent: 'test',
    ip_address: '127.0.0.1',
    session_public_key: 'test-pubkey',
  });
  return token;
}

describe('portal step-up attempt counter', () => {
  it('3 wrong attempts revoke the session; next call is unauthorized', async () => {
    const { identityId } = await seedVerifiedClient();
    const token = await issueSessionTokenFor(identityId);
    const cookie = `vibe.portal=${token}`;

    const a1 = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '0000' });
    expect(a1.status).toBe(401);
    expect(a1.body.remaining).toBe(2);

    const a2 = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '0001' });
    expect(a2.status).toBe(401);
    expect(a2.body.remaining).toBe(1);

    const a3 = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '0002' });
    expect(a3.status).toBe(401);
    expect(a3.body.error).toBe('session_revoked');

    // Further attempts: the session row is revoked → loadSessionFromCookie returns null.
    const a4 = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '0003' });
    expect(a4.status).toBe(401);
  });

  it('a correct answer resets the attempt counter and sets verified_until', async () => {
    const { identityId } = await seedVerifiedClient();
    const token = await issueSessionTokenFor(identityId);
    const cookie = `vibe.portal=${token}`;

    const bad = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '0000' });
    expect(bad.status).toBe(401);
    expect(bad.body.remaining).toBe(2);

    const good = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '1234' });
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);
  });
});
