/**
 * Phase 28.12 — Staff notification ticker integration tests.
 *
 * Covers:
 *   - email channel: outbox file lands + audit row + plaintext template
 *     uses decrypted client name
 *   - in_app channel: pgFanout `publish` is called with the right shape
 *   - admin-escalation template (admin.pdf_conversion_failed) goes
 *     through this ticker, not the client ticker (template-id filter
 *     keeps them tiled)
 *   - permanent failure path
 *   - the client ticker does NOT claim staff-template rows (and vice-versa)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import { tickOnce } from '../services/intakeStaffNotifyTicker.js';
import { tickOnce as clientTickOnce } from '../services/intakeClientNotifyTicker.js';

let app: Express;
let staffId: string;
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
  staffId = (await db('users').where({ username: 'alice' }).first('id'))!.id as string;
  await db('users').where({ id: staffId }).update({ show_on_intake_card: true });
  const mod = await import('../app.js');
  app = mod.createApp();
  const env = await import('../env.js');
  outboxDir = path.resolve(env.env.outboxDir);
});

beforeEach(async () => {
  await db('intake_notifications_outbox').del();
  await db('intake_sessions').del();
});

afterAll(async () => {
  try {
    await fs.rm(path.join(outboxDir, 'email'), { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

async function createSession(): Promise<string> {
  const r = await request(app).post('/api/public/intake/sessions').send({
    staffId,
    name: 'Maria Staff-Notify',
    email: 'staff-notify-test@example.com',
  });
  expect(r.status).toBe(201);
  return r.body.sessionId as string;
}

async function listEmailFiles(): Promise<string[]> {
  try {
    return await fs.readdir(path.join(outboxDir, 'email'));
  } catch {
    return [];
  }
}

describe('Phase 28.12 — staff notify ticker', () => {
  it('sends staff email with "new intake from [name]" subject + decrypted client name in body', async () => {
    const sessionId = await createSession();
    // Enqueue the staff email row directly so we don't depend on a full
    // upload+finalize cycle in this file.
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'email',
      recipient_hash: staffId,
      template_id: 'staff.new_intake',
      payload: JSON.stringify({ file_count: 4 }) as unknown as never,
      status: 'pending',
    });
    const before = await listEmailFiles();
    await tickOnce();
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId, channel: 'email' })
      .first();
    expect(row.status).toBe('sent');
    const after = await listEmailFiles();
    expect(after.length).toBe(before.length + 1);
    // Inspect the outbox file contents — confirm it contains the decrypted
    // client name and the file count.
    const newest = after.filter((n) => !before.includes(n))[0]!;
    const body = await fs.readFile(path.join(outboxDir, 'email', newest), 'utf8');
    expect(body).toContain('Maria Staff-Notify');
    expect(body).toMatch(/4 files/);
    // Audit
    const audit = await db('audit_log').where({
      action: 'intake.staff_notification.sent',
      target_id: sessionId,
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('publishes intake.session.received on the pgFanout for the in_app channel', async () => {
    const sessionId = await createSession();
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'in_app',
      recipient_hash: staffId,
      template_id: 'staff.new_intake',
      payload: JSON.stringify({ file_count: 2 }) as unknown as never,
      status: 'pending',
    });
    const fanout = await import('../realtime/pgFanout.js');
    const spy = vi.spyOn(fanout, 'publish').mockResolvedValue(undefined);
    try {
      await tickOnce();
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'intake.session.received',
          userId: staffId,
          sessionId,
          fileCount: 2,
        }),
      );
    } finally {
      spy.mockRestore();
    }
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId, channel: 'in_app' })
      .first();
    expect(row.status).toBe('sent');
  });

  it('admin-escalation template (admin.pdf_conversion_failed) flows through the staff ticker', async () => {
    const sessionId = await createSession();
    const admin = (await db('users').where({ username: 'kurt' }).first())!;
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'email',
      recipient_hash: admin.id,
      template_id: 'admin.pdf_conversion_failed',
      payload: JSON.stringify({ jobId: 'job-x', error: 'sample failure' }) as unknown as never,
      status: 'pending',
    });
    const before = await listEmailFiles();
    await tickOnce();
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId, template_id: 'admin.pdf_conversion_failed' })
      .first();
    expect(row.status).toBe('sent');
    const after = await listEmailFiles();
    const newest = after.filter((n) => !before.includes(n))[0]!;
    const body = await fs.readFile(path.join(outboxDir, 'email', newest), 'utf8');
    expect(body).toMatch(/Action needed/);
    expect(body).toContain('sample failure');
  });

  it('client ticker does NOT claim staff-template rows', async () => {
    const sessionId = await createSession();
    // Pre-existing client row stays untouched; we add a staff row and
    // assert running the CLIENT ticker doesn't flip it.
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'email',
      recipient_hash: staffId,
      template_id: 'staff.new_intake',
      payload: JSON.stringify({ file_count: 1 }) as unknown as never,
      status: 'pending',
    });
    await clientTickOnce();
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId, template_id: 'staff.new_intake' })
      .first();
    // Staff ticker hasn't run yet, so the row should still be 'pending'
    // (NOT 'sending' or 'sent') after the client ticker passed it over.
    expect(row.status).toBe('pending');
  });

  it('permanent failure (3 attempts) marks status=failed + audit row', async () => {
    const sessionId = await createSession();
    // Send to a user with no email address — sendEmail throws every time
    // (staff_user_has_no_email) → retry → permanent fail after 3 attempts.
    await db('users').where({ id: staffId }).update({ email: null });
    try {
      await db('intake_notifications_outbox').insert({
        session_id: sessionId,
        channel: 'email',
        recipient_hash: staffId,
        template_id: 'staff.new_intake',
        payload: JSON.stringify({ file_count: 1 }) as unknown as never,
        status: 'pending',
      });
      for (let i = 0; i < 3; i++) {
        await tickOnce();
        // Bypass the backoff so the next tick re-claims.
        await db('intake_notifications_outbox')
          .where({ session_id: sessionId })
          .update({ next_attempt_at: db.fn.now() });
      }
      const row = await db('intake_notifications_outbox')
        .where({ session_id: sessionId })
        .first();
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(3);
      const audit = await db('audit_log').where({
        action: 'intake.staff_notification.failed',
        target_id: sessionId,
      });
      expect(audit.length).toBe(1);
    } finally {
      await db('users').where({ id: staffId }).update({ email: 'alice@vibeconnect.local' });
    }
  });
});

describe('Phase 28.12 — per-staff notification preference (QA-followup)', () => {
  it('in_app_only: email rows are marked sent with skipped-by-preference reason', async () => {
    const sessionId = await createSession();
    await db('users').where({ id: staffId }).update({ intake_notify_mode: 'in_app_only' });
    try {
      await db('intake_notifications_outbox').insert({
        session_id: sessionId,
        channel: 'email',
        recipient_hash: staffId,
        template_id: 'staff.new_intake',
        payload: JSON.stringify({ file_count: 2 }) as unknown as never,
        status: 'pending',
      });
      const before = await listEmailFiles();
      await tickOnce();
      const row = await db('intake_notifications_outbox')
        .where({ session_id: sessionId, channel: 'email' })
        .first();
      expect(row.status).toBe('sent');
      expect(row.last_error).toBe('skipped_by_preference:in_app_only');
      // No outbox file written — the send was skipped entirely.
      const after = await listEmailFiles();
      expect(after.length).toBe(before.length);
    } finally {
      await db('users').where({ id: staffId }).update({ intake_notify_mode: 'realtime' });
    }
  });

  it('in_app_only: in_app rows still process realtime (preference does not affect in-app channel)', async () => {
    const sessionId = await createSession();
    await db('users').where({ id: staffId }).update({ intake_notify_mode: 'in_app_only' });
    try {
      await db('intake_notifications_outbox').insert({
        session_id: sessionId,
        channel: 'in_app',
        recipient_hash: staffId,
        template_id: 'staff.new_intake',
        payload: JSON.stringify({ file_count: 2 }) as unknown as never,
        status: 'pending',
      });
      const fanout = await import('../realtime/pgFanout.js');
      const spy = vi.spyOn(fanout, 'publish').mockResolvedValue(undefined);
      try {
        await tickOnce();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const row = await db('intake_notifications_outbox')
        .where({ session_id: sessionId, channel: 'in_app' })
        .first();
      expect(row.status).toBe('sent');
    } finally {
      await db('users').where({ id: staffId }).update({ intake_notify_mode: 'realtime' });
    }
  });

  it('digest: email rows are deferred to the next digest hour', async () => {
    const sessionId = await createSession();
    await db('users').where({ id: staffId }).update({ intake_notify_mode: 'digest' });
    // Pin the digest hour to one we know is in the future relative to now
    // so the deferred row's next_attempt_at lands at "today" if we're
    // before that hour, "tomorrow" if we're past. Test must work in both.
    await db('firm_settings').where({ id: 1 }).update({ intake_digest_hour_local: 23 });
    try {
      await db('intake_notifications_outbox').insert({
        session_id: sessionId,
        channel: 'email',
        recipient_hash: staffId,
        template_id: 'staff.new_intake',
        payload: JSON.stringify({ file_count: 3 }) as unknown as never,
        status: 'pending',
      });
      const before = await listEmailFiles();
      await tickOnce();
      const row = await db('intake_notifications_outbox')
        .where({ session_id: sessionId, channel: 'email' })
        .first();
      expect(row.status).toBe('deferred');
      expect(row.last_error).toBe('awaiting_digest_window');
      // No mail file written — the row was parked.
      const after = await listEmailFiles();
      expect(after.length).toBe(before.length);
    } finally {
      await db('users').where({ id: staffId }).update({ intake_notify_mode: 'realtime' });
    }
  });

  it('digest: admin.* templates bypass the digest defer and send immediately', async () => {
    // Admin escalation (PDF conversion failure) must reach the admin
    // immediately even when their preference is 'digest'. Tested with
    // the seeded admin user kurt who has intake_notify_mode=digest.
    const sessionId = await createSession();
    const admin = (await db('users').where({ username: 'kurt' }).first())!;
    await db('users').where({ id: admin.id }).update({ intake_notify_mode: 'digest' });
    try {
      await db('intake_notifications_outbox').insert({
        session_id: sessionId,
        channel: 'email',
        recipient_hash: admin.id,
        template_id: 'admin.pdf_conversion_failed',
        payload: JSON.stringify({ error: 'oh no', jobId: 'j-1' }) as unknown as never,
        status: 'pending',
      });
      const before = await listEmailFiles();
      await tickOnce();
      const row = await db('intake_notifications_outbox')
        .where({ session_id: sessionId, template_id: 'admin.pdf_conversion_failed' })
        .first();
      expect(row.status).toBe('sent');
      const after = await listEmailFiles();
      expect(after.length).toBe(before.length + 1);
    } finally {
      await db('users').where({ id: admin.id }).update({ intake_notify_mode: 'realtime' });
    }
  });

  it('digest: matured deferred rows flush as one aggregated email per recipient', async () => {
    const sessionId1 = await createSession();
    const sessionId2 = await createSession();
    await db('users').where({ id: staffId }).update({ intake_notify_mode: 'digest' });
    try {
      // Insert two already-matured deferred rows (next_attempt_at in the
      // past) — simulating two intakes that landed earlier and parked
      // until the digest window opened.
      await db('intake_notifications_outbox').insert([
        {
          session_id: sessionId1,
          channel: 'email',
          recipient_hash: staffId,
          template_id: 'staff.new_intake',
          payload: JSON.stringify({ file_count: 2 }) as unknown as never,
          status: 'deferred',
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          session_id: sessionId2,
          channel: 'email',
          recipient_hash: staffId,
          template_id: 'staff.new_intake',
          payload: JSON.stringify({ file_count: 5 }) as unknown as never,
          status: 'deferred',
          next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ]);
      const before = await listEmailFiles();
      await tickOnce();
      const after = await listEmailFiles();
      // Exactly ONE digest email file written, not two.
      expect(after.length).toBe(before.length + 1);
      // Both source rows flipped to 'sent'.
      const rows = await db('intake_notifications_outbox')
        .whereIn('session_id', [sessionId1, sessionId2])
        .where('channel', 'email');
      expect(rows.every((r) => r.status === 'sent')).toBe(true);
      // Digest audit row carries both session ids.
      const audit = await db('audit_log').where({
        action: 'intake.staff_notification.sent',
        target_id: staffId,
      });
      const digestAudit = audit.find(
        (a) => (a.details as { mode?: string }).mode === 'digest',
      );
      expect(digestAudit).toBeDefined();
      expect((digestAudit!.details as { session_count: number }).session_count).toBe(2);
      expect((digestAudit!.details as { file_count: number }).file_count).toBe(7);
      // Mail body contains both session ids (truncated to 8 chars each).
      const newest = after.filter((n) => !before.includes(n))[0]!;
      const body = await fs.readFile(path.join(outboxDir, 'email', newest), 'utf8');
      expect(body).toContain(sessionId1.slice(0, 8));
      expect(body).toContain(sessionId2.slice(0, 8));
    } finally {
      await db('users').where({ id: staffId }).update({ intake_notify_mode: 'realtime' });
    }
  });
});
