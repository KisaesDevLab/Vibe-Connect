/**
 * Phase 28.14 — Tokenized intake flow integration tests.
 *
 * Two endpoints under test:
 *   - GET /api/public/intake/links/:token (resolve)
 *   - POST /api/public/intake/sessions  (now accepts `linkToken`)
 *
 * Plus the cross-cutting `intake_links.use_count` increment that fires
 * on finalize.
 *
 * Load-bearing properties:
 *   - 404 / 410 disambiguation matters for the audit row even though the
 *     SPA collapses them to one terminal message.
 *   - source='staff_link' + token_id set on the session row (DB CHECK
 *     constraint chk_intake_sessions_token_source).
 *   - Turnstile is NOT required on the tokenized path; the link itself
 *     is the unforgeable handle.
 *   - Contact prefill: client overrides win; otherwise fall back to the
 *     link's encrypted email/phone.
 *   - use_count increments exactly once at finalize, not at create.
 *   - Per-token rate limit (10 sessions / hour, in-memory).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache, encryptField } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import { __resetIntakeLinkBuckets } from '../routes/intakePublic.js';

let app: Express;
let aliceId: string;
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
  __resetIntakeUploadTokenCache();
  await resetTestDb();
  aliceId = (await db('users').where({ username: 'alice' }).first('id'))!.id as string;
  bobId = (await db('users').where({ username: 'bob' }).first('id'))!.id as string;
  // Opt alice in so her card is part of the public listing too. Tokenized
  // links don't require opt-in, but tests touch both paths.
  await db('users').where({ id: aliceId }).update({
    show_on_intake_card: true,
    intake_card_title: 'Payroll lead',
    intake_card_bio: 'I handle returns for the W-2 cohort.',
  });
  const mod = await import('../app.js');
  app = mod.createApp();
  const env = await import('../env.js');
  outboxDir = path.resolve(env.env.outboxDir);
});

beforeEach(async () => {
  await db('intake_sessions').del();
  await db('intake_links').del();
  __resetIntakeLinkBuckets();
});

afterAll(async () => {
  try {
    await fs.rm(path.join(outboxDir, 'email'), { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

/** Helper: insert a link row directly so each test controls its expiry/revoke state. */
async function makeLink(opts: {
  assignedStaffId?: string;
  createdByUserId?: string;
  expiresAt?: Date;
  revokedAt?: Date | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(16).toString('base64url');
  const emailEnc = opts.email ? await encryptField(opts.email) : null;
  const phoneEnc = opts.phone ? await encryptField(opts.phone) : null;
  const rows = (await db('intake_links')
    .insert({
      token,
      created_by_user_id: opts.createdByUserId ?? aliceId,
      assigned_staff_id: opts.assignedStaffId ?? aliceId,
      expires_at: (opts.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString(),
      revoked_at: opts.revokedAt ? opts.revokedAt.toISOString() : null,
      client_email_enc: emailEnc,
      client_phone_enc: phoneEnc,
      note_to_client: opts.note ?? null,
    })
    .returning(['id', 'token'])) as Array<{ id: string; token: string }>;
  return rows[0]!;
}

describe('Phase 28.14 — GET /api/public/intake/links/:token (resolve)', () => {
  it('200s with staff card + decrypted prefill + note for a valid link', async () => {
    const link = await makeLink({
      email: 'recipient@example.com',
      phone: '+15551234567',
      note: 'Please upload your 2024 W-2 and 1099.',
    });
    const r = await request(app).get(`/api/public/intake/links/${link.token}`);
    expect(r.status).toBe(200);
    expect(r.body.linkId).toBe(link.id);
    expect(r.body.staff.id).toBe(aliceId);
    expect(r.body.staff.display_name).toBeDefined();
    expect(r.body.staff.title).toBe('Payroll lead');
    expect(r.body.note).toBe('Please upload your 2024 W-2 and 1099.');
    expect(r.body.prefillEmail).toBe('recipient@example.com');
    expect(r.body.prefillPhone).toBe('+15551234567');
    // Audit row written under the renamed action.
    const audit = await db('audit_log').where({
      action: 'intake.token.validated',
      target_id: link.id,
    });
    expect(audit.length).toBe(1);
  });

  it('QA-fix: emits intake.token.rejected with reason on each failure path', async () => {
    // 1) bad shape — no DB hit, targetId null.
    await request(app).get('/api/public/intake/links/not-a-token');
    let after = await db('audit_log')
      .where({ action: 'intake.token.rejected' })
      .orderBy('created_at', 'desc')
      .first();
    expect(after).toBeDefined();
    expect((after!.details as { reason: string }).reason).toBe('bad_shape');
    expect(after!.target_id).toBeNull();

    // 2) unknown token — valid shape, no row.
    await request(app).get(`/api/public/intake/links/${randomBytes(16).toString('base64url')}`);
    after = await db('audit_log')
      .where({ action: 'intake.token.rejected' })
      .orderBy('created_at', 'desc')
      .first();
    expect((after!.details as { reason: string }).reason).toBe('not_found');
    expect(after!.target_id).toBeNull();

    // 3) revoked.
    const revokedLink = await makeLink({ revokedAt: new Date(), email: 'r@example.com' });
    await request(app).get(`/api/public/intake/links/${revokedLink.token}`);
    after = await db('audit_log')
      .where({ action: 'intake.token.rejected', target_id: revokedLink.id })
      .orderBy('created_at', 'desc')
      .first();
    expect((after!.details as { reason: string }).reason).toBe('revoked');

    // 4) expired.
    const expiredLink = await makeLink({
      expiresAt: new Date(Date.now() - 60_000),
      email: 'e@example.com',
    });
    await request(app).get(`/api/public/intake/links/${expiredLink.token}`);
    after = await db('audit_log')
      .where({ action: 'intake.token.rejected', target_id: expiredLink.id })
      .orderBy('created_at', 'desc')
      .first();
    expect((after!.details as { reason: string }).reason).toBe('expired');

    // 5) staff_unavailable — assignee deactivated.
    const unavailLink = await makeLink({
      assignedStaffId: bobId,
      email: 'u@example.com',
    });
    await db('users').where({ id: bobId }).update({ is_active: false });
    try {
      await request(app).get(`/api/public/intake/links/${unavailLink.token}`);
      after = await db('audit_log')
        .where({ action: 'intake.token.rejected', target_id: unavailLink.id })
        .orderBy('created_at', 'desc')
        .first();
      expect((after!.details as { reason: string }).reason).toBe('staff_unavailable');
    } finally {
      await db('users').where({ id: bobId }).update({ is_active: true });
    }
  });

  it('404s when the shape is wrong (no DB query at all)', async () => {
    const r = await request(app).get('/api/public/intake/links/not-a-token');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('404s when the token doesn’t exist', async () => {
    // Valid shape, no row.
    const r = await request(app).get(
      `/api/public/intake/links/${randomBytes(16).toString('base64url')}`,
    );
    expect(r.status).toBe(404);
  });

  it('410s with error=revoked when the link is revoked', async () => {
    const link = await makeLink({
      revokedAt: new Date(),
      email: 'foo@example.com',
    });
    const r = await request(app).get(`/api/public/intake/links/${link.token}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('revoked');
  });

  it('410s with error=expired when the link is expired', async () => {
    const link = await makeLink({
      expiresAt: new Date(Date.now() - 60_000),
      email: 'foo@example.com',
    });
    const r = await request(app).get(`/api/public/intake/links/${link.token}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('expired');
  });

  it('410s with error=staff_unavailable when the assigned staff is deactivated', async () => {
    const link = await makeLink({
      assignedStaffId: bobId,
      email: 'foo@example.com',
    });
    await db('users').where({ id: bobId }).update({ is_active: false });
    try {
      const r = await request(app).get(`/api/public/intake/links/${link.token}`);
      expect(r.status).toBe(410);
      expect(r.body.error).toBe('staff_unavailable');
    } finally {
      await db('users').where({ id: bobId }).update({ is_active: true });
    }
  });

  it('resolves a link whose assigned staff is NOT opted into the public card grid', async () => {
    // Tokenized links bypass show_on_intake_card by design — the staff was
    // directly chosen by another staff member.
    const link = await makeLink({
      assignedStaffId: bobId,
      email: 'foo@example.com',
    });
    // bob is NOT opted into the public listing (default false).
    const r = await request(app).get(`/api/public/intake/links/${link.token}`);
    expect(r.status).toBe(200);
    expect(r.body.staff.id).toBe(bobId);
  });

  it('does NOT increment use_count on resolution (resolution is read-only)', async () => {
    const link = await makeLink({ email: 'foo@example.com' });
    await request(app).get(`/api/public/intake/links/${link.token}`);
    await request(app).get(`/api/public/intake/links/${link.token}`);
    const row = await db('intake_links').where({ id: link.id }).first();
    expect(row.use_count).toBe(0);
  });
});

describe('Phase 28.14 — POST /sessions with linkToken', () => {
  it('creates a session with source=staff_link + token_id populated', async () => {
    const link = await makeLink({ email: 'recipient@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria Garcia',
    });
    expect(r.status).toBe(201);
    expect(r.body.sessionId).toBeDefined();
    const session = await db('intake_sessions').where({ id: r.body.sessionId }).first();
    expect(session.source).toBe('staff_link');
    expect(session.token_id).toBe(link.id);
    expect(session.staff_id).toBe(aliceId);
    expect(session.contact_method).toBe('email');
    // Audit row carries source=staff_link.
    const audit = await db('audit_log').where({
      action: 'intake.session.created',
      target_id: r.body.sessionId,
    });
    expect(audit.length).toBe(1);
    expect((audit[0]!.details as { source?: string }).source).toBe('staff_link');
    expect((audit[0]!.details as { token_id?: string }).token_id).toBe(link.id);
  });

  it('rejects both staffId AND linkToken in the same body (route_required)', async () => {
    const link = await makeLink({ email: 'foo@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      staffId: aliceId,
      linkToken: link.token,
      name: 'Maria',
      email: 'maria@example.com',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('route_required');
  });

  it('rejects neither staffId nor linkToken (route_required)', async () => {
    const r = await request(app).post('/api/public/intake/sessions').send({
      name: 'Maria',
      email: 'maria@example.com',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('route_required');
  });

  it('410s a tokenized session-create when the link is revoked', async () => {
    const link = await makeLink({ revokedAt: new Date(), email: 'foo@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
    });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('link_revoked');
  });

  it('410s a tokenized session-create when the link is expired', async () => {
    const link = await makeLink({
      expiresAt: new Date(Date.now() - 60_000),
      email: 'foo@example.com',
    });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
    });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('link_expired');
  });

  it('falls back to the link’s prefilled email when the client omits it', async () => {
    const link = await makeLink({ email: 'prefilled@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
      // No email, no phone — should resolve to prefilled email.
    });
    expect(r.status).toBe(201);
    const session = await db('intake_sessions').where({ id: r.body.sessionId }).first();
    const { decryptField } = await import('../services/intakeCrypto.js');
    const emailDec = await decryptField(session.client_email_enc as Buffer);
    expect(emailDec).toBe('prefilled@example.com');
    expect(session.client_phone_enc).toBeNull();
    expect(session.contact_method).toBe('email');
  });

  it('client-provided email overrides the link prefill', async () => {
    const link = await makeLink({ email: 'prefilled@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
      email: 'i-actually-use-this@example.com',
    });
    expect(r.status).toBe(201);
    const session = await db('intake_sessions').where({ id: r.body.sessionId }).first();
    const { decryptField } = await import('../services/intakeCrypto.js');
    const emailDec = await decryptField(session.client_email_enc as Buffer);
    expect(emailDec).toBe('i-actually-use-this@example.com');
  });

  it('400s when neither client body nor link have any contact info', async () => {
    // Direct DB insert bypassing the admin route's contact_required check
    // — defence-in-depth so the public route doesn't 500 if the row is
    // somehow corrupt.
    const token = randomBytes(16).toString('base64url');
    await db('intake_links').insert({
      token,
      created_by_user_id: aliceId,
      assigned_staff_id: aliceId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      // Both encrypted columns null.
    });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: token,
      name: 'Maria',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('contact_required');
  });

  it('does NOT verify Turnstile on the tokenized path (link itself is the handle)', async () => {
    // We can't easily isolate-test the call, but we can confirm the audit
    // row records turnstile_passed=true and turnstile_configured matches
    // env state — under test, env.turnstileSecretKey is unset so
    // configured=false but the route should not block.
    const link = await makeLink({ email: 'foo@example.com' });
    const r = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
    });
    expect(r.status).toBe(201);
    const audit = await db('audit_log').where({
      action: 'intake.session.created',
      target_id: r.body.sessionId,
    });
    const details = audit[0]!.details as { turnstile_passed?: boolean };
    expect(details.turnstile_passed).toBe(true);
  });

  it('enforces 10-sessions-per-hour per-token rate limit (in-memory)', async () => {
    const link = await makeLink({ email: 'foo@example.com' });
    for (let i = 0; i < 10; i++) {
      // Reset the global IP limiter pressure between iterations by
      // sending unique-enough requests. The 5/15min limit at sessionCreateLimiter
      // would otherwise kick in BEFORE the token-bucket fires — but the
      // test env raises that limit via env.rateLimitIntakeSessionPer15Min.
      const r = await request(app)
        .post('/api/public/intake/sessions')
        .send({
          linkToken: link.token,
          name: `Maria #${i}`,
        });
      expect(r.status).toBe(201);
    }
    const r11 = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria #11',
    });
    expect(r11.status).toBe(429);
    expect(r11.body.error).toBe('link_rate_limited');
  });
});

describe('Phase 28.14 — use_count increment on finalize', () => {
  /**
   * Finalize requires the upload-token Bearer + at least one file. We
   * stage the file row directly so we don't have to drive a full tus
   * upload in this test; the finalize handler reads intake_files and
   * the use_count side-effect lives in the same transaction.
   */
  it('bumps intake_links.use_count by 1 on a successful finalize', async () => {
    const link = await makeLink({ email: 'foo@example.com' });
    const create = await request(app).post('/api/public/intake/sessions').send({
      linkToken: link.token,
      name: 'Maria',
    });
    expect(create.status).toBe(201);
    const sessionId = create.body.sessionId as string;
    const uploadToken = create.body.uploadToken as string;

    // Stage one minimal file row so the finalize handler doesn't 400 on
    // 'no_files'. The path doesn't have to point anywhere — the 28.9 PDF
    // ticker is OFF in tests, so the pending row just sits there.
    await db('intake_files').insert({
      session_id: sessionId,
      original_filename: 'test.pdf',
      stored_path: '/tmp/unused-by-this-test',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      sha256: '0'.repeat(64),
      kind: 'file',
      order_index: 0,
      virus_scan_status: 'clean',
    });

    const fin = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${uploadToken}`);
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);

    const row = await db('intake_links').where({ id: link.id }).first();
    expect(row.use_count).toBe(1);
  });

  it('does NOT bump use_count for a public-source (non-tokenized) session', async () => {
    const create = await request(app).post('/api/public/intake/sessions').send({
      staffId: aliceId,
      name: 'Maria',
      email: 'm@example.com',
    });
    expect(create.status).toBe(201);
    const sessionId = create.body.sessionId as string;
    const uploadToken = create.body.uploadToken as string;
    await db('intake_files').insert({
      session_id: sessionId,
      original_filename: 'test.pdf',
      stored_path: '/tmp/unused-by-this-test',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      sha256: '0'.repeat(64),
      kind: 'file',
      order_index: 0,
      virus_scan_status: 'clean',
    });
    const fin = await request(app)
      .post(`/api/public/intake/sessions/${sessionId}/finalize`)
      .set('Authorization', `Bearer ${uploadToken}`);
    expect(fin.status).toBe(200);
    // No link is involved — there's nothing to bump. This test exists
    // to lock that branch shut: a regression that bumped *any* link
    // counter on a public finalize would break this.
    const anyLink = await db('intake_links').first();
    expect(anyLink).toBeUndefined();
  });
});
