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

function extractSessionCookie(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const headers = Array.isArray(raw) ? raw : [raw];
  for (const h of headers) {
    const m = /^vibe\.portal=([^;]+)/.exec(h);
    if (m) return `vibe.portal=${m[1]}`;
  }
  return null;
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

  // STEPUP end-to-end gate: verifies the CLAUDE.md invariant that a client whose
  // identity has verification_required=true can observe conversation metadata
  // but cannot receive the wrapped conversation key until step-up succeeds.
  // Without the wrapped key, the XChaCha20-Poly1305 message ciphertext is
  // unreadable — this is the encryption-layer belt to the API-layer suspenders.
  it('withholds wrappedKeys until step-up passes; releases them after', async () => {
    const { db } = await import('../db/knex.js');
    const { identityId } = await seedVerifiedClient();
    const token = await issueSessionTokenFor(identityId);
    const cookie = `vibe.portal=${token}`;

    // Seed a minimal external conversation with this client as a member + a
    // wrapped-keys row so there's something to gate on.
    const [conv] = await db('conversations')
      .insert({ type: 'external', display_name: 'Gate Test' })
      .returning(['id']);
    const convId = (conv as { id: string }).id;
    await db('conversation_members').insert({
      conversation_id: convId,
      external_identity_id: identityId,
    });
    await db('conversation_keys').insert({
      conversation_id: convId,
      rotation_version: 1,
      wrapped_keys: JSON.stringify({ [`client:${identityId}:invite`]: 'sealed-key-blob' }),
    });

    // Pre-verification: the portal MUST NOT surface wrapped keys.
    const before = await request(app)
      .get(`/portal/conversations/${convId}`)
      .set('Cookie', cookie);
    expect(before.status).toBe(200);
    expect(before.body.stepupRequired).toBe(true);
    expect(before.body.wrappedKeys).toBeNull();
    expect(before.body.rotationVersion).toBeNull();

    // Complete step-up with the correct last-4. Successful step-up rotates
    // the session token (M7) so we must use the new cookie for subsequent
    // requests, not the pre-verification one.
    const ok = await request(app)
      .post('/portal/stepup')
      .set('Cookie', cookie)
      .send({ last4: '1234' });
    expect(ok.status).toBe(200);
    const rotatedCookie = extractSessionCookie(ok.headers['set-cookie']) ?? cookie;

    // Post-verification: the same endpoint now hands over the wrapped key so
    // the client can unseal messages for this session (until verified_until
    // expires, at which point the gate re-engages on the next request).
    const after = await request(app)
      .get(`/portal/conversations/${convId}`)
      .set('Cookie', rotatedCookie);
    expect(after.status).toBe(200);
    expect(after.body.stepupRequired).toBe(false);
    expect(after.body.rotationVersion).toBe(1);
    expect(after.body.wrappedKeys).toEqual({
      [`client:${identityId}:invite`]: 'sealed-key-blob',
    });

    // Audit trail: there must be a withheld row for the pre-verification
    // attempt and a viewed row for the post-verification fetch.
    const withheld = await db('audit_log')
      .where({
        action: 'portal.convkey_withheld_stepup',
        target_id: convId,
        actor_external_identity_id: identityId,
      })
      .first();
    expect(withheld).toBeTruthy();
    const viewed = await db('audit_log')
      .where({
        action: 'portal.conversation_viewed',
        target_id: convId,
        actor_external_identity_id: identityId,
      })
      .first();
    expect(viewed).toBeTruthy();
  });
});
