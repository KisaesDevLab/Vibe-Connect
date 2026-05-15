/**
 * Phase 28.11 — Staff received-uploads view integration tests.
 *
 * RBAC is the highest-stakes property: staff seeing other staff's
 * sessions would leak client PII across the firm. Tests cover both the
 * list path and the detail path with two staff agents.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache, searchHash } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';

let app: Express;
let aliceStaffId: string;
let bobStaffId: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  if (!process.env.CONNECT_INTAKE_ENCRYPTION_KEY) {
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  __resetIntakeCryptoCache();
  __resetIntakeUploadTokenCache();
  await resetTestDb();
  aliceStaffId = (await db('users').where({ username: 'alice' }).first('id'))!.id as string;
  bobStaffId = (await db('users').where({ username: 'bob' }).first('id'))!.id as string;
  await db('users').whereIn('id', [aliceStaffId, bobStaffId]).update({ show_on_intake_card: true });
  const mod = await import('../app.js');
  app = mod.createApp();
});

beforeEach(async () => {
  await db('intake_files').del();
  await db('intake_sessions').del();
  await db('intake_session_archives').del();
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return agent;
}

async function createSessionFor(
  staffId: string,
  opts: { name?: string; email?: string; phone?: string } = {},
): Promise<string> {
  const r = await request(app)
    .post('/api/public/intake/sessions')
    .send({
      staffId,
      name: opts.name ?? 'Maria Admin-View',
      email: opts.email ?? 'admin-view@example.com',
      phone: opts.phone ?? '+15551234567',
    });
  expect(r.status).toBe(201);
  return r.body.sessionId as string;
}

describe('Phase 28.11 — GET /admin/intake/sessions list + RBAC', () => {
  it('staff sees only their own sessions', async () => {
    const aliceSess = await createSessionFor(aliceStaffId);
    const bobSess = await createSessionFor(bobStaffId);
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent.get('/admin/intake/sessions');
    expect(r.status).toBe(200);
    const ids = r.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(aliceSess);
    expect(ids).not.toContain(bobSess);
  });

  it('admin sees every session', async () => {
    const aliceSess = await createSessionFor(aliceStaffId);
    const bobSess = await createSessionFor(bobStaffId);
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurtAgent.get('/admin/intake/sessions');
    expect(r.status).toBe(200);
    const ids = r.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(aliceSess);
    expect(ids).toContain(bobSess);
  });

  it('admin can filter to a specific staff member', async () => {
    await createSessionFor(aliceStaffId);
    const bobSess = await createSessionFor(bobStaffId);
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurtAgent.get(`/admin/intake/sessions?staffId=${bobStaffId}`);
    expect(r.status).toBe(200);
    const ids = r.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toEqual([bobSess]);
  });

  it('archived sessions are hidden by default and visible with includeArchived', async () => {
    const sessId = await createSessionFor(aliceStaffId);
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    await aliceAgent.post(`/admin/intake/sessions/${sessId}/archive`);
    const r1 = await aliceAgent.get('/admin/intake/sessions');
    expect(r1.body.sessions.map((s: { id: string }) => s.id)).not.toContain(sessId);
    const r2 = await aliceAgent.get('/admin/intake/sessions?includeArchived=true');
    expect(r2.body.sessions.map((s: { id: string }) => s.id)).toContain(sessId);
  });
});

describe('Phase 28.11 — GET /admin/intake/sessions/:id detail', () => {
  it('returns decrypted PII for the assigned staff', async () => {
    const sessId = await createSessionFor(aliceStaffId, {
      name: 'María García',
      email: 'maria@example.com',
      phone: '+15559876543',
    });
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent.get(`/admin/intake/sessions/${sessId}`);
    expect(r.status).toBe(200);
    expect(r.body.session.clientName).toBe('María García');
    expect(r.body.session.clientEmail).toBe('maria@example.com');
    expect(r.body.session.clientPhone).toBe('+15559876543');
  });

  it('returns 403 for a different staff member', async () => {
    const sessId = await createSessionFor(aliceStaffId);
    const bobAgent = await loginAs('bob', 'bob-dev-only-ChangeMe!');
    const r = await bobAgent.get(`/admin/intake/sessions/${sessId}`);
    expect(r.status).toBe(403);
  });

  it('emits an audit row on every detail view (decryption_on_view)', async () => {
    const sessId = await createSessionFor(aliceStaffId);
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const before = await db('audit_log')
      .where({ action: 'intake.session.decrypted_on_view', target_id: sessId })
      .count();
    await aliceAgent.get(`/admin/intake/sessions/${sessId}`);
    await aliceAgent.get(`/admin/intake/sessions/${sessId}`);
    const after = await db('audit_log')
      .where({ action: 'intake.session.decrypted_on_view', target_id: sessId })
      .count();
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count) + 2);
    const aud = await db('audit_log')
      .where({ action: 'intake.session.decrypted_on_view', target_id: sessId })
      .orderBy('created_at', 'desc')
      .first();
    // No plaintext IP in details — only the hash.
    expect(aud.details).toHaveProperty('viewer_ip_hash');
    expect(JSON.stringify(aud.details)).not.toContain('127.0.0.1');
  });
});

describe('Phase 28.11 — search', () => {
  it('finds a session by email hash', async () => {
    const sessId = await createSessionFor(aliceStaffId, {
      email: 'search-target@example.com',
    });
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent
      .post('/admin/intake/sessions/search')
      .send({ q: 'search-target@example.com' });
    expect(r.status).toBe(200);
    const ids = r.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(sessId);
  });

  it('does not return a different staff member\'s match (RBAC for non-admin)', async () => {
    const bobSess = await createSessionFor(bobStaffId, { email: 'rbac-test@example.com' });
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent
      .post('/admin/intake/sessions/search')
      .send({ q: 'rbac-test@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: { id: string }) => s.id)).not.toContain(bobSess);
  });

  it('admin search ignores staff filter and finds across the firm', async () => {
    const bobSess = await createSessionFor(bobStaffId, { email: 'admin-search@example.com' });
    const kurtAgent = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurtAgent
      .post('/admin/intake/sessions/search')
      .send({ q: 'admin-search@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: { id: string }) => s.id)).toContain(bobSess);
  });

  it('search hash is deterministic — repeated queries find the same row', async () => {
    const sessId = await createSessionFor(aliceStaffId, { email: 'determinism@example.com' });
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r1 = await aliceAgent
      .post('/admin/intake/sessions/search')
      .send({ q: 'determinism@example.com' });
    const r2 = await aliceAgent
      .post('/admin/intake/sessions/search')
      .send({ q: 'determinism@example.com' });
    expect(r1.body.sessions.map((s: { id: string }) => s.id)).toContain(sessId);
    expect(r2.body.sessions.map((s: { id: string }) => s.id)).toContain(sessId);
    // searchHash exposed for cross-check.
    expect(searchHash('determinism@example.com')).toBeTruthy();
  });
});

describe('Phase 28.11 — link / unlink Connect client', () => {
  it('links a session to an external_identity and unlinks reversibly', async () => {
    const sessId = await createSessionFor(aliceStaffId);
    // Seed an external_identity to link to.
    const [client] = (await db('external_identities')
      .insert({
        email: `link-test-${Date.now()}@example.com`,
        display_name: 'Linked Client',
        firm_client_ref: 'L-001',
      })
      .returning(['id'])) as Array<{ id: string }>;
    const clientId = client!.id;
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const link = await aliceAgent
      .post(`/admin/intake/sessions/${sessId}/link-client`)
      .send({ clientId });
    expect(link.status).toBe(200);
    expect(link.body.client.id).toBe(clientId);
    const row = await db('intake_sessions').where({ id: sessId }).first();
    expect(row.linked_connect_client_id).toBe(clientId);
    expect(row.linked_by_user_id).toBe(aliceStaffId);
    expect(row.linked_at).not.toBeNull();

    const audit = await db('audit_log')
      .where({ action: 'intake.session.client_linked', target_id: sessId })
      .first();
    expect(audit).toBeDefined();

    const unlink = await aliceAgent.delete(`/admin/intake/sessions/${sessId}/link-client`);
    expect(unlink.status).toBe(200);
    const cleared = await db('intake_sessions').where({ id: sessId }).first();
    expect(cleared.linked_connect_client_id).toBeNull();
    expect(cleared.linked_by_user_id).toBeNull();
    expect(cleared.linked_at).toBeNull();
  });

  it('rejects linking a non-existent client', async () => {
    const sessId = await createSessionFor(aliceStaffId);
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent
      .post(`/admin/intake/sessions/${sessId}/link-client`)
      .send({ clientId: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('unknown_client');
  });

  it('staff cannot link another staff member\'s session', async () => {
    const sessId = await createSessionFor(bobStaffId);
    const [client] = (await db('external_identities')
      .insert({ email: `cross-${Date.now()}@example.com`, display_name: 'X' })
      .returning(['id'])) as Array<{ id: string }>;
    const aliceAgent = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await aliceAgent
      .post(`/admin/intake/sessions/${sessId}/link-client`)
      .send({ clientId: client!.id });
    expect(r.status).toBe(403);
  });
});

describe('Phase 28.11 — POST /admin/intake/sessions/zip (bulk-zip)', () => {
  it('400s on empty body / non-uuid ids', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r1 = await kurt.post('/admin/intake/sessions/zip').send({ sessionIds: [] });
    expect(r1.status).toBe(400);
    const r2 = await kurt.post('/admin/intake/sessions/zip').send({ sessionIds: ['not-uuid'] });
    expect(r2.status).toBe(400);
  });

  it('404s when none of the requested sessions are authorised', async () => {
    const bobSess = await createSessionFor(bobStaffId);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/sessions/zip')
      .send({ sessionIds: [bobSess] });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_sessions_authorised');
  });

  it('streams a non-empty zip for an admin selecting two sessions; audits inclusions', async () => {
    const aliceSess = await createSessionFor(aliceStaffId);
    const bobSess = await createSessionFor(bobStaffId);
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post('/admin/intake/sessions/zip')
      .send({ sessionIds: [aliceSess, bobSess] })
      .buffer(true)
      .parse((res, cb) => {
        // supertest's default parser tries to JSON-parse — override to
        // capture the raw zip bytes as a Buffer for assertion.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/zip/);
    const body = r.body as Buffer;
    // ZIP signature: "PK\x03\x04" or "PK\x05\x06" (end-of-central-dir
    // for an empty archive — we just want to confirm it's a zip).
    expect(body.length).toBeGreaterThan(50);
    expect(body.subarray(0, 2).toString('ascii')).toBe('PK');
    // Two intake.bulk_zip.included audit rows + one intake.bulk_zip.exported.
    const inclAudit = await db('audit_log').where({ action: 'intake.bulk_zip.included' });
    expect(inclAudit.length).toBe(2);
    const expAudit = await db('audit_log').where({ action: 'intake.bulk_zip.exported' });
    expect(expAudit.length).toBe(1);
    expect((expAudit[0]!.details as { included: number }).included).toBe(2);
    expect((expAudit[0]!.details as { skipped: number }).skipped).toBe(0);
  });

  it('skips unauthorised ids in a mixed batch and records the skip in the manifest/audit', async () => {
    const aliceSess = await createSessionFor(aliceStaffId);
    const bobSess = await createSessionFor(bobStaffId);
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/sessions/zip')
      .send({ sessionIds: [aliceSess, bobSess] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    // Only alice's session was authorised — bob's silently skipped.
    const expAudit = await db('audit_log').where({ action: 'intake.bulk_zip.exported' }).first();
    expect((expAudit!.details as { included: number }).included).toBe(1);
    expect((expAudit!.details as { skipped: number }).skipped).toBe(1);
    expect((expAudit!.details as { requested: number }).requested).toBe(2);
  });
});
