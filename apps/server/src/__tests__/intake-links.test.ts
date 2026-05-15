/**
 * Phase 28.13 — Send-a-link generator integration tests.
 *
 * Covers token entropy, RBAC on create/assign/revoke/resend, list
 * filters, send-via-email/SMS, encryption of the contact at rest,
 * audit emissions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache, decryptField } from '../services/intakeCrypto.js';

let app: Express;
let bobId: string;
let outboxDir: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test';
  if (!process.env.CONNECT_INTAKE_ENCRYPTION_KEY) {
    process.env.CONNECT_INTAKE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  }
  __resetIntakeCryptoCache();
  await resetTestDb();
  bobId = (await db('users').where({ username: 'bob' }).first('id'))!.id as string;
  const mod = await import('../app.js');
  app = mod.createApp();
  const env = await import('../env.js');
  outboxDir = path.resolve(env.env.outboxDir);
});

beforeEach(async () => {
  await db('intake_links').del();
});

afterAll(async () => {
  try {
    await fs.rm(path.join(outboxDir, 'email'), { recursive: true, force: true });
    await fs.rm(path.join(outboxDir, 'sms'), { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

type TestAgent = ReturnType<typeof request.agent>;
async function loginAs(username: string, password: string): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post('/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return agent;
}

describe('Phase 28.13 — POST /admin/intake/links', () => {
  it('creates a link with a 22-char base64url token', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/links')
      .send({ email: 'client-a@example.com', expiresIn: '24h' });
    expect(r.status).toBe(201);
    expect(r.body.link.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.body.link.url).toContain(`/intake/t/${r.body.link.token}`);
  });

  it('rejects neither email nor phone with contact_required', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post('/admin/intake/links').send({ expiresIn: '24h' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('contact_required');
  });

  it('rejects non-admin attempting to assign the link to another staff', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice
      .post('/admin/intake/links')
      .send({ email: 'x@example.com', assignedStaffId: bobId });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden_assign_other_staff');
  });

  it('admin can assign the link to any active staff', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt
      .post('/admin/intake/links')
      .send({ email: 'admin-assign@example.com', assignedStaffId: bobId });
    expect(r.status).toBe(201);
    const row = await db('intake_links').where({ id: r.body.link.id }).first();
    expect(row.assigned_staff_id).toBe(bobId);
  });

  it('encrypts the contact email/phone at rest (no plaintext in the row)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post('/admin/intake/links').send({
      email: 'secret-at-rest@example.com',
      phone: '+15551234567',
    });
    expect(r.status).toBe(201);
    const row = await db('intake_links').where({ id: r.body.link.id }).first();
    const asJson = JSON.stringify(row);
    expect(asJson).not.toContain('secret-at-rest@example.com');
    expect(asJson).not.toContain('+15551234567');
    expect(Buffer.isBuffer(row.client_email_enc)).toBe(true);
    expect(Buffer.isBuffer(row.client_phone_enc)).toBe(true);
    const decE = await decryptField(row.client_email_enc as Buffer);
    expect(decE).toBe('secret-at-rest@example.com');
    const decP = await decryptField(row.client_phone_enc as Buffer);
    expect(decP).toBe('+15551234567');
  });

  it('sends via email when an address is provided (mock outbox file written)', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const before = await fs.readdir(path.join(outboxDir, 'email')).catch(() => [] as string[]);
    const r = await alice
      .post('/admin/intake/links')
      .send({ email: 'send-test@example.com', expiresIn: '24h' });
    expect(r.status).toBe(201);
    expect(r.body.link.send.email).toBe(true);
    const after = await fs.readdir(path.join(outboxDir, 'email')).catch(() => [] as string[]);
    expect(after.length).toBe(before.length + 1);
    const newest = after.filter((n) => !before.includes(n))[0]!;
    const body = await fs.readFile(path.join(outboxDir, 'email', newest), 'utf8');
    expect(body).toContain(r.body.link.url);
    // Audit
    const audit = await db('audit_log').where({
      action: 'intake.link.sent',
      target_id: r.body.link.id,
    });
    expect(audit.length).toBe(1);
  });

  it('honours the optional `note_to_client` field in the email body', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post('/admin/intake/links').send({
      email: 'with-note@example.com',
      note: 'We need your 2024 W-2 and 1099 forms before next Friday.',
    });
    expect(r.status).toBe(201);
    const files = await fs.readdir(path.join(outboxDir, 'email'));
    const newest = files[files.length - 1]!;
    const body = await fs.readFile(path.join(outboxDir, 'email', newest), 'utf8');
    expect(body).toContain('2024 W-2 and 1099');
  });
});

describe('Phase 28.13 — list / revoke / resend', () => {
  async function createLink(agent: TestAgent, body: Record<string, unknown>): Promise<string> {
    const r = await agent.post('/admin/intake/links').send(body);
    if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.link.id as string;
  }

  it('list shows active links by default; filter exposes revoked / expired', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const active = await createLink(alice, {
      email: 'l-active@example.com',
      expiresIn: '7d',
    });
    const willRevoke = await createLink(alice, {
      email: 'l-revoke@example.com',
      expiresIn: '7d',
    });
    await alice.post(`/admin/intake/links/${willRevoke}/revoke`);

    const r1 = await alice.get('/admin/intake/links?filter=active');
    expect(r1.status).toBe(200);
    const activeIds = r1.body.links.map((l: { id: string }) => l.id);
    expect(activeIds).toContain(active);
    expect(activeIds).not.toContain(willRevoke);

    const r2 = await alice.get('/admin/intake/links?filter=revoked');
    expect(r2.body.links.map((l: { id: string }) => l.id)).toContain(willRevoke);

    const r3 = await alice.get('/admin/intake/links?filter=all');
    expect(r3.body.links.map((l: { id: string }) => l.id)).toContain(active);
    expect(r3.body.links.map((l: { id: string }) => l.id)).toContain(willRevoke);
  });

  it('list RBAC: staff sees only links they created or are assigned to', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const aliceLinkId = await createLink(alice, { email: 'alice-own@example.com' });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    // Admin-created link assigned to Bob — Alice should NOT see it.
    const bobLinkRes = await kurt.post('/admin/intake/links').send({
      email: 'bob-link@example.com',
      assignedStaffId: bobId,
    });
    const bobLinkId = bobLinkRes.body.link.id as string;
    const r = await alice.get('/admin/intake/links?filter=all');
    const ids = r.body.links.map((l: { id: string }) => l.id);
    expect(ids).toContain(aliceLinkId);
    expect(ids).not.toContain(bobLinkId);
  });

  it('revoke writes revoked_at + audit row + becomes idempotent', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const id = await createLink(alice, { email: 'rev-test@example.com' });
    const r1 = await alice.post(`/admin/intake/links/${id}/revoke`);
    expect(r1.status).toBe(200);
    const row1 = await db('intake_links').where({ id }).first();
    expect(row1.revoked_at).not.toBeNull();
    const audit = await db('audit_log').where({ action: 'intake.link.revoked', target_id: id });
    expect(audit.length).toBe(1);
    // Idempotent.
    const r2 = await alice.post(`/admin/intake/links/${id}/revoke`);
    expect(r2.status).toBe(200);
    expect(r2.body.alreadyRevoked).toBe(true);
  });

  it('resend sends again + emits intake.link.resent audit', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const id = await createLink(alice, { email: 'resend-test@example.com' });
    const before = await fs.readdir(path.join(outboxDir, 'email'));
    const r = await alice.post(`/admin/intake/links/${id}/resend`);
    expect(r.status).toBe(200);
    const after = await fs.readdir(path.join(outboxDir, 'email'));
    expect(after.length).toBe(before.length + 1);
    const audit = await db('audit_log').where({ action: 'intake.link.resent', target_id: id });
    expect(audit.length).toBe(1);
  });

  it('resend rejects a revoked link', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const id = await createLink(alice, { email: 'rev-resend@example.com' });
    await alice.post(`/admin/intake/links/${id}/revoke`);
    const r = await alice.post(`/admin/intake/links/${id}/resend`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('revoked');
  });
});
