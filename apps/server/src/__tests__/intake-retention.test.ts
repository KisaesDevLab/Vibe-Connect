/**
 * Phase 28.15 — Intake retention policy + auto-purge ticker.
 *
 * Coverage:
 *   - Finalize stamps `auto_delete_at` when policy is enabled and
 *     leaves it NULL when disabled.
 *   - Sweep purges overdue finalized sessions, deletes encrypted bytes
 *     from disk (local storage), cascades to intake_files / intake_pdfs,
 *     and writes `intake.session.auto_purged` BEFORE the delete.
 *   - Audit row survives the cascade — the load-bearing CLAUDE.md
 *     invariant that intake reuses `audit_log` (no FK back to intake).
 *   - Sweep ignores `open` / `expired` / `abandoned` sessions and
 *     future-dated `auto_delete_at`.
 *   - PATCH /admin/intake/settings flips with backfill + clear semantics.
 *   - Per-session admin override (keep / revert).
 *   - Admin RBAC on every new write path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import {
  __resetIntakeCryptoCache,
  encryptField,
} from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import {
  runIntakeAutoPurgeSweep,
  applyRetentionBackfill,
  clearAllAutoDeleteAt,
} from '../services/intakeAutoPurgeTicker.js';

let app: Express;
let aliceId: string;
let kurtId: string;
let storageRoot: string;

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
  kurtId = (await db('users').where({ username: 'kurt' }).first('id'))!.id as string;
  await db('users').where({ id: aliceId }).update({ show_on_intake_card: true });
  const mod = await import('../app.js');
  app = mod.createApp();
  const env = await import('../env.js');
  // Mirrors the path computation in services/attachmentStorage.ts:
  // LocalStorage roots at `${attachmentLocalDir}/attachments`.
  storageRoot = path.resolve(env.env.attachmentLocalDir, 'attachments');
});

beforeEach(async () => {
  // Reset firm_settings retention back to default-off so each test is
  // isolated. The migration default is enabled=false / days=365.
  await db('firm_settings').where({ id: 1 }).update({
    intake_auto_delete_enabled: false,
    intake_auto_delete_after_days: 365,
  });
  await db('intake_sessions').del();
  // Clear stored test files written by prior cases so dir-listing checks
  // are deterministic. attachmentStorage.delete swallows ENOENT.
  try {
    await fs.rm(storageRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

afterAll(async () => {
  try {
    await fs.rm(storageRoot, { recursive: true, force: true });
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

/** Insert a finalized session + one on-disk encrypted file blob. */
async function seedFinalizedSession(opts: {
  finalizedDaysAgo?: number;
  autoDeleteAt?: Date | null;
  status?: 'open' | 'finalized' | 'expired' | 'abandoned';
}): Promise<{ sessionId: string; storedPath: string }> {
  const effectiveStatus = opts.status ?? 'finalized';
  const finalizedAt =
    effectiveStatus === 'finalized'
      ? new Date(Date.now() - (opts.finalizedDaysAgo ?? 1) * 24 * 60 * 60 * 1000)
      : null;
  const nameEnc = await encryptField('Maria Garcia');
  const emailEnc = await encryptField('maria@example.com');
  const rows = (await db('intake_sessions')
    .insert({
      staff_id: aliceId,
      source: 'public',
      token_id: null,
      client_name_enc: nameEnc,
      client_email_enc: emailEnc,
      client_phone_enc: null,
      contact_method: 'email',
      status: effectiveStatus,
      upload_token_jti: randomBytes(16).toString('base64url'),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      finalized_at: finalizedAt ? finalizedAt.toISOString() : null,
      auto_delete_at:
        opts.autoDeleteAt === undefined
          ? null
          : opts.autoDeleteAt === null
            ? null
            : opts.autoDeleteAt.toISOString(),
    })
    .returning(['id'])) as Array<{ id: string }>;
  const sessionId = rows[0]!.id;

  // Write a real ciphertext byte to disk via attachmentStorage so the
  // sweep's storage.delete can verify the unlink actually happened.
  const { attachmentStorage } = await import('../services/attachmentStorage.js');
  const storedPath = await attachmentStorage().put(
    `intake/test-${sessionId}.bin`,
    Buffer.from('fake-ciphertext-for-test'),
  );

  await db('intake_files').insert({
    session_id: sessionId,
    original_filename: 'doc.pdf',
    stored_path: storedPath,
    mime_type: 'application/pdf',
    size_bytes: 24,
    sha256: '0'.repeat(64),
    kind: 'file',
    order_index: 0,
    virus_scan_status: 'clean',
  });

  return { sessionId, storedPath };
}

describe('Phase 28.15 — finalize hook (auto_delete_at stamping)', () => {
  it('stamps auto_delete_at = NOW() + N days when policy is enabled', async () => {
    await db('firm_settings').where({ id: 1 }).update({
      intake_auto_delete_enabled: true,
      intake_auto_delete_after_days: 60,
    });
    const create = await request(app)
      .post('/api/public/intake/sessions')
      .send({ staffId: aliceId, name: 'Maria', email: 'm@example.com' });
    expect(create.status).toBe(201);
    const sessionId = create.body.sessionId as string;
    const uploadToken = create.body.uploadToken as string;
    await db('intake_files').insert({
      session_id: sessionId,
      original_filename: 'doc.pdf',
      stored_path: '/tmp/unused',
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
    const row = await db('intake_sessions').where({ id: sessionId }).first();
    expect(row.auto_delete_at).toBeTruthy();
    // 60 days in the future (give or take a minute of clock drift).
    const t = new Date(row.auto_delete_at).getTime();
    const expected = Date.now() + 60 * 24 * 60 * 60 * 1000;
    expect(Math.abs(t - expected)).toBeLessThan(2 * 60 * 1000);
  });

  it('leaves auto_delete_at NULL when policy is disabled', async () => {
    // Default state: disabled.
    const create = await request(app)
      .post('/api/public/intake/sessions')
      .send({ staffId: aliceId, name: 'Maria', email: 'm@example.com' });
    const sessionId = create.body.sessionId as string;
    const uploadToken = create.body.uploadToken as string;
    await db('intake_files').insert({
      session_id: sessionId,
      original_filename: 'doc.pdf',
      stored_path: '/tmp/unused',
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
    const row = await db('intake_sessions').where({ id: sessionId }).first();
    expect(row.auto_delete_at).toBeNull();
  });
});

describe('Phase 28.15 — runIntakeAutoPurgeSweep', () => {
  it('purges overdue finalized sessions, deletes the file on disk, writes audit BEFORE the delete', async () => {
    const { sessionId, storedPath } = await seedFinalizedSession({
      finalizedDaysAgo: 90,
      autoDeleteAt: new Date(Date.now() - 60_000),
    });
    // Confirm the file landed on disk before the sweep.
    const fullPath = path.join(storageRoot, storedPath);
    await fs.stat(fullPath); // throws if missing — make the precondition explicit
    const result = await runIntakeAutoPurgeSweep();
    expect(result.sessionsPurged).toBe(1);
    expect(result.filesDeleted).toBe(1);
    // Session + cascade rows gone.
    expect(await db('intake_sessions').where({ id: sessionId }).first()).toBeUndefined();
    expect(await db('intake_files').where({ session_id: sessionId }).first()).toBeUndefined();
    // File on disk actually unlinked.
    await expect(fs.stat(fullPath)).rejects.toThrow();
    // Audit row survives the cascade — the load-bearing CLAUDE.md
    // invariant that intake reuses the global audit_log table.
    const audit = await db('audit_log').where({
      action: 'intake.session.auto_purged',
      target_id: sessionId,
    });
    expect(audit.length).toBe(1);
    expect((audit[0]!.details as { file_count?: number }).file_count).toBe(1);
  });

  it('ignores future-dated auto_delete_at', async () => {
    await seedFinalizedSession({
      finalizedDaysAgo: 30,
      autoDeleteAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    });
    const result = await runIntakeAutoPurgeSweep();
    expect(result.sessionsPurged).toBe(0);
  });

  it('ignores NULL auto_delete_at (override = "keep indefinitely")', async () => {
    await seedFinalizedSession({
      finalizedDaysAgo: 9999,
      autoDeleteAt: null,
    });
    const result = await runIntakeAutoPurgeSweep();
    expect(result.sessionsPurged).toBe(0);
  });

  it('ignores non-finalized sessions even with overdue auto_delete_at', async () => {
    await seedFinalizedSession({
      status: 'open',
      autoDeleteAt: new Date(Date.now() - 60_000),
    });
    const result = await runIntakeAutoPurgeSweep();
    expect(result.sessionsPurged).toBe(0);
  });

  it('QA-fix: retains the session when a non-ENOENT blob delete fails (orphan-blob guard)', async () => {
    // Seed a finalized overdue session; then point its file row at a
    // non-existent disk path so attachmentStorage.delete swallows the
    // ENOENT and behaves like a successful purge. Then point at a path
    // that triggers a path-traversal rejection — a non-ENOENT error.
    // Expectation: the session row stays so the next sweep can retry,
    // rather than deleting the row and orphaning whatever still lives
    // on disk.
    const seed = await seedFinalizedSession({
      finalizedDaysAgo: 90,
      autoDeleteAt: new Date(Date.now() - 60_000),
    });
    // Stage a second file row that will fail with a non-ENOENT error:
    // the LocalStorage driver rejects paths containing `..` with
    // 'invalid_storage_key' — a synchronous throw that exercises the
    // error branch.
    await db('intake_files').insert({
      session_id: seed.sessionId,
      original_filename: 'bad.pdf',
      stored_path: '../escape-attempt.bin',
      mime_type: 'application/pdf',
      size_bytes: 1,
      sha256: '0'.repeat(64),
      kind: 'file',
      order_index: 1,
      virus_scan_status: 'clean',
    });
    const result = await runIntakeAutoPurgeSweep();
    // The session is NOT purged — the orphan-blob guard caught the
    // non-ENOENT failure and skipped the row delete.
    expect(result.sessionsPurged).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    const row = await db('intake_sessions').where({ id: seed.sessionId }).first();
    expect(row).toBeDefined();
    // Audit row still fired BEFORE the failure — operator can trace
    // the attempt even though the row stayed.
    const audit = await db('audit_log').where({
      action: 'intake.session.auto_purged',
      target_id: seed.sessionId,
    });
    expect(audit.length).toBe(1);
  });
});

describe('Phase 28.15 — backfill / clear helpers', () => {
  it('applyRetentionBackfill fills NULL auto_delete_at for finalized sessions with 7-day floor', async () => {
    // Finalized 365d ago: max(now+7d, finalized+30d) → now+7d wins.
    const s1 = await seedFinalizedSession({ finalizedDaysAgo: 365 });
    // Finalized 5d ago: max(now+7d, finalized+30d) → finalized+30d wins.
    const s2 = await seedFinalizedSession({ finalizedDaysAgo: 5 });
    const { touched } = await applyRetentionBackfill(30);
    expect(touched).toBe(2);

    const row1 = await db('intake_sessions').where({ id: s1.sessionId }).first();
    const t1 = new Date(row1.auto_delete_at).getTime();
    expect(t1).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    // Should be ~now+7d, not 365d-ago+30d which would already be past.
    expect(t1).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);

    const row2 = await db('intake_sessions').where({ id: s2.sessionId }).first();
    const t2 = new Date(row2.auto_delete_at).getTime();
    // finalized 5d ago + 30d = ~25d from now.
    expect(t2).toBeGreaterThan(Date.now() + 24 * 24 * 60 * 60 * 1000);
    expect(t2).toBeLessThan(Date.now() + 26 * 24 * 60 * 60 * 1000);
  });

  it('applyRetentionBackfill is idempotent: a second call leaves already-set rows alone', async () => {
    const s1 = await seedFinalizedSession({ finalizedDaysAgo: 30 });
    await applyRetentionBackfill(30);
    const row1 = await db('intake_sessions').where({ id: s1.sessionId }).first();
    const before = row1.auto_delete_at;
    const result = await applyRetentionBackfill(60);
    expect(result.touched).toBe(0);
    const row2 = await db('intake_sessions').where({ id: s1.sessionId }).first();
    expect(row2.auto_delete_at).toEqual(before);
  });

  it('clearAllAutoDeleteAt clears every row', async () => {
    const s1 = await seedFinalizedSession({
      finalizedDaysAgo: 30,
      autoDeleteAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const s2 = await seedFinalizedSession({
      finalizedDaysAgo: 90,
      autoDeleteAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const { touched } = await clearAllAutoDeleteAt();
    expect(touched).toBe(2);
    const r1 = await db('intake_sessions').where({ id: s1.sessionId }).first();
    const r2 = await db('intake_sessions').where({ id: s2.sessionId }).first();
    expect(r1.auto_delete_at).toBeNull();
    expect(r2.auto_delete_at).toBeNull();
  });
});

describe('Phase 28.15 — PATCH /admin/intake/settings', () => {
  it('admin can read + update settings', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const g = await kurt.get('/admin/intake/settings');
    expect(g.status).toBe(200);
    expect(g.body.settings.intake_auto_delete_enabled).toBe(false);
    const p = await kurt.patch('/admin/intake/settings').send({
      intake_auto_delete_after_days: 90,
      intake_send_to_both_channels: false,
    });
    expect(p.status).toBe(200);
    expect(p.body.settings.intake_auto_delete_after_days).toBe(90);
    expect(p.body.settings.intake_send_to_both_channels).toBe(false);
    const audit = await db('audit_log').where({ action: 'intake.settings.updated' });
    expect(audit.length).toBe(1);
    const changed = (audit[0]!.details as { changed: Record<string, unknown> }).changed;
    expect(Object.keys(changed)).toEqual(
      expect.arrayContaining(['intake_auto_delete_after_days', 'intake_send_to_both_channels']),
    );
  });

  it('non-admin staff cannot read or write settings', async () => {
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const g = await alice.get('/admin/intake/settings');
    expect(g.status).toBe(403);
    const p = await alice.patch('/admin/intake/settings').send({ intake_auto_delete_after_days: 60 });
    expect(p.status).toBe(403);
  });

  it('flipping enabled OFF→ON backfills historical sessions', async () => {
    const s1 = await seedFinalizedSession({ finalizedDaysAgo: 30 });
    expect(
      (await db('intake_sessions').where({ id: s1.sessionId }).first()).auto_delete_at,
    ).toBeNull();
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const p = await kurt.patch('/admin/intake/settings').send({
      intake_auto_delete_enabled: true,
      intake_auto_delete_after_days: 60,
    });
    expect(p.status).toBe(200);
    const row = await db('intake_sessions').where({ id: s1.sessionId }).first();
    expect(row.auto_delete_at).toBeTruthy();
  });

  it('flipping enabled ON→OFF clears every auto_delete_at ("off means off")', async () => {
    await db('firm_settings').where({ id: 1 }).update({ intake_auto_delete_enabled: true });
    const s1 = await seedFinalizedSession({
      finalizedDaysAgo: 30,
      autoDeleteAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const p = await kurt
      .patch('/admin/intake/settings')
      .send({ intake_auto_delete_enabled: false });
    expect(p.status).toBe(200);
    const row = await db('intake_sessions').where({ id: s1.sessionId }).first();
    expect(row.auto_delete_at).toBeNull();
  });

  it('rejects after_days outside [30, 3650]', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const p1 = await kurt.patch('/admin/intake/settings').send({
      intake_auto_delete_after_days: 7,
    });
    expect(p1.status).toBe(400);
    const p2 = await kurt.patch('/admin/intake/settings').send({
      intake_auto_delete_after_days: 99999,
    });
    expect(p2.status).toBe(400);
  });

  it('empty PATCH is a no-op: no audit row written', async () => {
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const auditsBefore = (await db('audit_log').count('* as c').first<{ c: string }>())?.c;
    const p = await kurt.patch('/admin/intake/settings').send({});
    expect(p.status).toBe(200);
    const auditsAfter = (await db('audit_log').count('* as c').first<{ c: string }>())?.c;
    expect(Number(auditsAfter)).toBe(Number(auditsBefore));
  });
});

describe('Phase 28.15 — per-session retention override', () => {
  it('admin can set keep-indefinitely (auto_delete_at → null) + audits', async () => {
    const s1 = await seedFinalizedSession({
      finalizedDaysAgo: 30,
      autoDeleteAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.post(`/admin/intake/sessions/${s1.sessionId}/keep-indefinitely`);
    expect(r.status).toBe(200);
    expect(r.body.autoDeleteAt).toBeNull();
    const row = await db('intake_sessions').where({ id: s1.sessionId }).first();
    expect(row.auto_delete_at).toBeNull();
    const audit = await db('audit_log').where({
      action: 'intake.session.retention_overridden',
      target_id: s1.sessionId,
    });
    expect(audit.length).toBe(1);
  });

  it('non-admin cannot override', async () => {
    const s1 = await seedFinalizedSession({ finalizedDaysAgo: 30 });
    const alice = await loginAs('alice', 'alice-dev-only-ChangeMe!');
    const r = await alice.post(`/admin/intake/sessions/${s1.sessionId}/keep-indefinitely`);
    expect(r.status).toBe(403);
  });

  it('revert (DELETE) re-derives auto_delete_at from firm policy when enabled', async () => {
    await db('firm_settings').where({ id: 1 }).update({
      intake_auto_delete_enabled: true,
      intake_auto_delete_after_days: 60,
    });
    const s1 = await seedFinalizedSession({ finalizedDaysAgo: 10, autoDeleteAt: null });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.delete(`/admin/intake/sessions/${s1.sessionId}/keep-indefinitely`);
    expect(r.status).toBe(200);
    expect(r.body.autoDeleteAt).toBeTruthy();
    const row = await db('intake_sessions').where({ id: s1.sessionId }).first();
    const t = new Date(row.auto_delete_at).getTime();
    // Finalized 10d ago + 60d = ~50d from now. Greater than the 7d floor.
    expect(t).toBeGreaterThan(Date.now() + 49 * 24 * 60 * 60 * 1000);
  });

  it('revert (DELETE) leaves auto_delete_at NULL when firm policy is off', async () => {
    // Policy is off by beforeEach.
    const s1 = await seedFinalizedSession({
      finalizedDaysAgo: 30,
      autoDeleteAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.delete(`/admin/intake/sessions/${s1.sessionId}/keep-indefinitely`);
    expect(r.status).toBe(200);
    expect(r.body.autoDeleteAt).toBeNull();
  });

  it('revert (DELETE) 400s on non-finalized sessions', async () => {
    const s1 = await seedFinalizedSession({ status: 'open' });
    const kurt = await loginAs('kurt', 'kurt-dev-only-ChangeMe!');
    const r = await kurt.delete(`/admin/intake/sessions/${s1.sessionId}/keep-indefinitely`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('not_finalized');
  });

  // kurt is the seeded admin — verifying that test users exist as expected.
  it('seeded admin user kurt has is_admin=true', async () => {
    const row = await db('users').where({ id: kurtId }).first('is_admin');
    expect(row.is_admin).toBe(true);
  });
});
