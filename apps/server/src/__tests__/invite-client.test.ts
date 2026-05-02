/**
 * Integration tests for the staff-facing POST /clients/invite endpoint.
 *
 * Seeded users used here:
 *   alice (non-admin staff) — password: alice-dev-only-ChangeMe!
 *   kurt (admin)            — password: kurt-dev-only-ChangeMe!
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
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const login = await agent.post('/auth/login').send({ username, password });
  if (login.status !== 200) {
    throw new Error(`loginAs(${username}) failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return agent;
}

// Each test starts with a fresh external_identities table so duplicate-detection
// tests aren't contaminated by earlier inserts. We don't reset the seed users —
// that would tear down the test harness between tests.
beforeEach(async () => {
  const { db } = await import('../db/knex.js');
  await db('external_identities').del();
  // Ensure client messaging is enabled by default for most tests.
  await db('firm_settings').where({ id: 1 }).update({ client_messaging_enabled: true });
});

describe('POST /clients/invite', () => {
  it('non-admin staff can invite a client with email only', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Rob Mathes',
      channels: {
        email: { enabled: true, value: 'rob-email-only@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'ssn', last4: '7234', reverifyEveryHours: 24 },
    });
    expect(res.status).toBe(201);
    expect(res.body.externalIdentityId).toEqual(expect.any(String));
    expect(res.body.invitePublicKey).toEqual(expect.any(String));
    expect(res.body.deliveryStatus.email).toBe('sent');
    expect(res.body.deliveryStatus.sms).toBeNull();

    // Row inserted with bcrypt'd last-4 (never the plaintext).
    const { db } = await import('../db/knex.js');
    const row = await db('external_identities').where({ id: res.body.externalIdentityId }).first();
    expect(row.email).toBe('rob-email-only@cfhcpa.test');
    expect(row.verification_type).toBe('ssn');
    expect(row.verification_required).toBe(true);
    expect(row.verification_last4_hash).toEqual(expect.any(String));
    expect(row.verification_last4_hash).not.toContain('7234');
    expect(row.invite_token_hash).toEqual(expect.any(String));
    expect(row.invite_public_key).toEqual(expect.any(String));
    expect(row.invited_via).toBe('email');
  });

  it('supports SMS-only invites and normalizes the via column accordingly', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Cell Only',
      channels: {
        email: { enabled: false, value: null },
        sms: { enabled: true, value: '+15555550123' },
      },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(201);
    expect(res.body.deliveryStatus.sms).toBe('sent');
    expect(res.body.deliveryStatus.email).toBeNull();

    const { db } = await import('../db/knex.js');
    const row = await db('external_identities').where({ id: res.body.externalIdentityId }).first();
    expect(row.phone).toBe('+15555550123');
    expect(row.invited_via).toBe('sms');
    expect(row.verification_type).toBe('none');
    expect(row.verification_required).toBe(false);
    expect(row.verification_last4_hash).toBeNull();
    // Email placeholder keeps the unique index happy for SMS-only clients.
    expect(row.email).toMatch(/^no-email-.*@placeholder\.invalid$/);
  });

  it('rejects zero enabled channels', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'No Channel',
      channels: {
        email: { enabled: false, value: null },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('rejects SSN type without last4', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Missing Last4',
      channels: { email: { enabled: true, value: 'missing@last4.test' }, sms: { enabled: false } },
      verification: { type: 'ssn' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-E.164 phone numbers (client is expected to normalize)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Bad Phone',
      channels: {
        email: { enabled: false, value: null },
        sms: { enabled: true, value: '(555) 123-4567' },
      },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 with existingId when an email is already taken', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const first = await agent.post('/clients/invite').send({
      displayName: 'Original',
      channels: { email: { enabled: true, value: 'dup@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
    });
    expect(first.status).toBe(201);
    const existingId = first.body.externalIdentityId;

    const dup = await agent.post('/clients/invite').send({
      displayName: 'Attempted Duplicate',
      channels: { email: { enabled: true, value: 'dup@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('email_taken');
    expect(dup.body.existingId).toBe(existingId);
    expect(dup.body.existingDisplayName).toBe('Original');
  });

  it('returns 403 when client_messaging_enabled is false', async () => {
    const { db } = await import('../db/knex.js');
    await db('firm_settings').where({ id: 1 }).update({ client_messaging_enabled: false });
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Locked Out',
      channels: {
        email: { enabled: true, value: 'locked@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('client_messaging_disabled');
  });

  it('requires auth', async () => {
    const res = await request(app)
      .post('/clients/invite')
      .send({
        displayName: 'Anon Try',
        channels: { email: { enabled: true, value: 'anon@cfhcpa.test' }, sms: { enabled: false } },
        verification: { type: 'none' },
      });
    expect(res.status).toBe(401);
  });

  // ---- Corrupt-input fuzz ---------------------------------------------------

  it('rejects an 81-character displayName (length cap is 80)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'x'.repeat(81),
      channels: { email: { enabled: true, value: 'len@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-4-digit last4 values (too short, too long, non-numeric)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    for (const bad of ['', '1', '123', '12345', 'abcd', '12 4', '12.4', '--34']) {
      const res = await agent.post('/clients/invite').send({
        displayName: 'Last4 Fuzz',
        channels: {
          email: { enabled: true, value: 'last4fuzz@cfhcpa.test' },
          sms: { enabled: false },
        },
        verification: { type: 'ssn', last4: bad, reverifyEveryHours: 24 },
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects reverifyEveryHours outside the allowed enum', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    for (const bad of [0, 1, 12, 48, 72, 9999, -1]) {
      const res = await agent.post('/clients/invite').send({
        displayName: 'Rev Fuzz',
        channels: {
          email: { enabled: true, value: 'revfuzz@cfhcpa.test' },
          sms: { enabled: false },
        },
        verification: { type: 'ssn', last4: '1234', reverifyEveryHours: bad },
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects malformed JSON payloads cleanly (400, not 500)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent
      .post('/clients/invite')
      .set('Content-Type', 'application/json')
      .send('{not-json');
    // Express' json body-parser raises a 400 on parse failure. The key invariant:
    // we don't crash the request with a 500.
    expect([400, 413]).toContain(res.status);
  });

  it('strips leading / trailing whitespace from displayName before persisting', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: '   Trimmed Name   ',
      channels: {
        email: { enabled: true, value: 'trim@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(201);
    const { db } = await import('../db/knex.js');
    const row = await db('external_identities').where({ id: res.body.externalIdentityId }).first();
    expect(row.display_name).toBe('Trimmed Name');
  });

  it('persists an <script>-bearing displayName verbatim without executing anywhere server-side', async () => {
    // The server is a JSON API — it never renders the name. This test proves
    // that (a) the route doesn't choke on angle-bracket content, (b) no
    // sanitizer silently munges the stored value (which would change what the
    // eventual client UI sees and is the attacker's real goal). Rendering is
    // the client's responsibility; React's default-escaping does the rest.
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const xss = '<script>alert(1)</script>';
    const res = await agent.post('/clients/invite').send({
      displayName: xss,
      channels: { email: { enabled: true, value: 'xss@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
    });
    expect(res.status).toBe(201);
    const { db } = await import('../db/knex.js');
    const row = await db('external_identities').where({ id: res.body.externalIdentityId }).first();
    expect(row.display_name).toBe(xss);
  });

  it('lowercases email input before duplicate-checking and persisting', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const mixed = await agent.post('/clients/invite').send({
      displayName: 'Case Fuzz',
      channels: {
        email: { enabled: true, value: 'CASE-fuzz@CFHCPA.Test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(mixed.status).toBe(201);
    const { db } = await import('../db/knex.js');
    const row = await db('external_identities')
      .where({ id: mixed.body.externalIdentityId })
      .first();
    expect(row.email).toBe('case-fuzz@cfhcpa.test');

    // Duplicate detection must be case-insensitive too.
    const dup = await agent.post('/clients/invite').send({
      displayName: 'Case Fuzz 2',
      channels: {
        email: { enabled: true, value: 'case-FUZZ@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('email_taken');
  });

  it('accepts both reverifyEveryHours=null (never) and 168 (7 days)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const never = await agent.post('/clients/invite').send({
      displayName: 'Never Reverify',
      channels: { email: { enabled: true, value: 'never@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'ssn', last4: '1234', reverifyEveryHours: null },
    });
    expect(never.status).toBe(201);

    const sevenDays = await agent.post('/clients/invite').send({
      displayName: 'Weekly Reverify',
      channels: { email: { enabled: true, value: 'weekly@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'ein', last4: '0000', reverifyEveryHours: 168 },
    });
    expect(sevenDays.status).toBe(201);
  });

  it('persists firmClientRef when provided (admin-originated invite path)', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Firm Ref Client',
      channels: {
        email: { enabled: true, value: 'firmref@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'none' },
      firmClientRef: 'ENG-2026-42',
    });
    expect(res.status).toBe(201);
    const { db } = await import('../db/knex.js');
    const row = await db('external_identities').where({ id: res.body.externalIdentityId }).first();
    expect(row.firm_client_ref).toBe('ENG-2026-42');
  });

  it('leaves firmClientRef null when omitted or whitespace-only', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const a = await agent.post('/clients/invite').send({
      displayName: 'Nulled Ref',
      channels: { email: { enabled: true, value: 'nullref@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
    });
    expect(a.status).toBe(201);
    const b = await agent.post('/clients/invite').send({
      displayName: 'Whitespace Ref',
      channels: { email: { enabled: true, value: 'wsref@cfhcpa.test' }, sms: { enabled: false } },
      verification: { type: 'none' },
      firmClientRef: '   ',
    });
    expect(b.status).toBe(201);
    const { db } = await import('../db/knex.js');
    const ra = await db('external_identities').where({ id: a.body.externalIdentityId }).first();
    const rb = await db('external_identities').where({ id: b.body.externalIdentityId }).first();
    expect(ra.firm_client_ref).toBeNull();
    expect(rb.firm_client_ref).toBeNull();
  });

  it('writes a client.invited audit row tied to the staff actor', async () => {
    const agent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const res = await agent.post('/clients/invite').send({
      displayName: 'Audited Client',
      channels: {
        email: { enabled: true, value: 'audit@cfhcpa.test' },
        sms: { enabled: false, value: null },
      },
      verification: { type: 'ein', last4: '9876', reverifyEveryHours: 8 },
    });
    expect(res.status).toBe(201);

    const { db } = await import('../db/knex.js');
    const aliceRow = await db('users').where({ username: 'alice' }).first();
    const audit = await db('audit_log')
      .where({
        action: 'client.invited',
        target_id: res.body.externalIdentityId,
        actor_user_id: aliceRow.id,
      })
      .first();
    expect(audit).toBeTruthy();
    expect(audit.details.channels).toEqual({ email: true, sms: false });
    expect(audit.details.verificationType).toBe('ein');
  });
});

afterAll(async () => {
  // Release the pg pool so Vitest can exit cleanly.
  const { db } = await import('../db/knex.js');
  await db.destroy();
});
