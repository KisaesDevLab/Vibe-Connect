/**
 * Phase 28.10 — Client receipt notification ticker integration tests.
 *
 * The 28.5 finalize endpoint already enqueues `intake_notifications_outbox`
 * rows; here we exercise the ticker that turns those rows into actual
 * email/SMS sends via the mock bridge providers.
 *
 * Mock providers write to `${env.outboxDir}/email|sms/` rather than
 * hitting an external service, so we assert the side effect by reading
 * those files.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from '../db/knex.js';
import { resetTestDb } from './test-helpers.js';
import { __resetIntakeCryptoCache } from '../services/intakeCrypto.js';
import { __resetIntakeUploadTokenCache } from '../services/intakeUploadToken.js';
import {
  nextAllowedSendTime,
  tickOnce,
} from '../services/intakeClientNotifyTicker.js';

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
  // Reset firm_settings to a 24-hour-allowed window so SMS-bearing tests
  // pass regardless of wall-clock time. Despite the column names, these
  // are the ALLOWED window (see `nextAllowedSendTime`); the production
  // default is 8..21 but we don't want tests to be flaky between 9pm and
  // 8am local. start=end=0 hits the wrapping branch and always returns
  // null (allowed). The dedicated quiet-hours test below overrides this.
  await db('firm_settings').where({ id: 1 }).update({
    sms_quiet_start_hour: 0,
    sms_quiet_end_hour: 0,
  });
});

afterAll(async () => {
  // Empty the mock outboxes so subsequent test files don't see stale files.
  try {
    await fs.rm(path.join(outboxDir, 'email'), { recursive: true, force: true });
    await fs.rm(path.join(outboxDir, 'sms'), { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

async function createSession(opts: {
  email?: string;
  phone?: string;
}): Promise<{ sessionId: string; token: string }> {
  const r = await request(app).post('/api/public/intake/sessions').send({
    staffId,
    name: 'Maria Notify',
    email: opts.email,
    phone: opts.phone,
  });
  expect(r.status).toBe(201);
  return { sessionId: r.body.sessionId, token: r.body.uploadToken };
}

async function listOutboxNames(channel: 'email' | 'sms'): Promise<string[]> {
  try {
    return await fs.readdir(path.join(outboxDir, channel));
  } catch {
    return [];
  }
}

async function enqueueAndFinalize(sessionId: string): Promise<void> {
  // Stand in for the 28.5 finalize endpoint's enqueue: insert one
  // outbox row per channel the session has. We do this directly via
  // db() so the test stays scoped to the ticker and doesn't depend on
  // having uploaded any files.
  const session = await db('intake_sessions').where({ id: sessionId }).first();
  if (session.client_email_hash) {
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'email',
      recipient_hash: session.client_email_hash,
      template_id: 'client.received',
      payload: JSON.stringify({ file_count: 3 }) as unknown as never,
      status: 'pending',
    });
  }
  if (session.client_phone_hash) {
    await db('intake_notifications_outbox').insert({
      session_id: sessionId,
      channel: 'sms',
      recipient_hash: session.client_phone_hash,
      template_id: 'client.received',
      payload: JSON.stringify({ file_count: 3 }) as unknown as never,
      status: 'pending',
    });
  }
}

describe('Phase 28.10 — client notification ticker', () => {
  it('email-only client receives email; no SMS row is created or sent', async () => {
    const { sessionId } = await createSession({ email: 'just-email@example.com' });
    await enqueueAndFinalize(sessionId);
    const emailBefore = await listOutboxNames('email');
    await tickOnce();
    const rows = await db('intake_notifications_outbox').where({ session_id: sessionId });
    expect(rows.length).toBe(1);
    expect(rows[0]!.channel).toBe('email');
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.sent_at).not.toBeNull();
    const emailAfter = await listOutboxNames('email');
    expect(emailAfter.length).toBe(emailBefore.length + 1);
  });

  it('phone-only client receives SMS; no email row created', async () => {
    const { sessionId } = await createSession({ phone: '+15551234567' });
    await enqueueAndFinalize(sessionId);
    const smsBefore = await listOutboxNames('sms');
    await tickOnce();
    const rows = await db('intake_notifications_outbox').where({ session_id: sessionId });
    expect(rows.length).toBe(1);
    expect(rows[0]!.channel).toBe('sms');
    expect(rows[0]!.status).toBe('sent');
    const smsAfter = await listOutboxNames('sms');
    expect(smsAfter.length).toBe(smsBefore.length + 1);
  });

  it('both-provided client receives both', async () => {
    const { sessionId } = await createSession({
      email: 'both-channels@example.com',
      phone: '+15551234567',
    });
    await enqueueAndFinalize(sessionId);
    await tickOnce();
    const rows = await db('intake_notifications_outbox').where({ session_id: sessionId });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.status).every((s) => s === 'sent')).toBe(true);
  });

  it('audit row carries hashed recipient (never plaintext)', async () => {
    const { sessionId } = await createSession({ email: 'plain-leak-test@example.com' });
    await enqueueAndFinalize(sessionId);
    await tickOnce();
    const audit = await db('audit_log')
      .where({ action: 'intake.client_notification.sent', target_id: sessionId })
      .first();
    expect(audit).toBeDefined();
    const details = audit.details as Record<string, unknown>;
    expect(details.channel).toBe('email');
    expect(typeof details.recipient_hash).toBe('string');
    expect(JSON.stringify(audit.details)).not.toContain('plain-leak-test@example.com');
  });

  it('SMS during quiet hours is deferred (next_attempt_at = next allowed hour)', async () => {
    // Force tight quiet hours so the current hour is definitely OUTSIDE
    // the allowed window. We set start=end=startHour so the wrapping
    // logic also gets exercised.
    const nowHour = new Date().getHours();
    // Allowed window of exactly one hour at hour+2 → guaranteed quiet now.
    const allowedStart = (nowHour + 2) % 24;
    const allowedEnd = (nowHour + 3) % 24;
    await db('firm_settings')
      .where({ id: 1 })
      .update({ sms_quiet_start_hour: allowedStart, sms_quiet_end_hour: allowedEnd });
    const { sessionId } = await createSession({ phone: '+15551234567' });
    await enqueueAndFinalize(sessionId);
    await tickOnce();
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId, channel: 'sms' })
      .first();
    expect(row.status).toBe('deferred');
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('permanent failure flips intake_sessions.notification_failed=true', async () => {
    const { sessionId } = await createSession({ email: 'perma-fail@example.com' });
    // Corrupt the encrypted email column so decryptField throws.
    await db('intake_sessions').where({ id: sessionId }).update({
      client_email_enc: Buffer.from('corrupt'),
    });
    await enqueueAndFinalize(sessionId);
    // 3 ticks → 3 attempts → permanent fail. We have to bump
    // next_attempt_at between ticks because the retry backoff would
    // otherwise keep the row out of reach.
    for (let i = 0; i < 3; i++) {
      await tickOnce();
      await db('intake_notifications_outbox')
        .where({ session_id: sessionId })
        .update({ next_attempt_at: db.fn.now() });
    }
    const row = await db('intake_notifications_outbox')
      .where({ session_id: sessionId })
      .first();
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    const session = await db('intake_sessions').where({ id: sessionId }).first();
    expect(session.notification_failed).toBe(true);
    const audit = await db('audit_log').where({
      action: 'intake.client_notification.failed',
      target_id: sessionId,
    });
    expect(audit.length).toBe(1);
  });
});

describe('Phase 28.10 — nextAllowedSendTime', () => {
  it('returns null when current hour is inside a simple allowed window', () => {
    const inside = new Date();
    inside.setHours(12, 0, 0, 0);
    expect(nextAllowedSendTime(inside, 8, 21)).toBeNull();
  });

  it('returns same-day start when current hour is before start', () => {
    const beforeStart = new Date();
    beforeStart.setHours(6, 0, 0, 0);
    const next = nextAllowedSendTime(beforeStart, 8, 21);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(8);
    expect(next!.getDate()).toBe(beforeStart.getDate());
  });

  it('returns tomorrow-start when current hour is after end', () => {
    const afterEnd = new Date();
    afterEnd.setHours(22, 0, 0, 0);
    const next = nextAllowedSendTime(afterEnd, 8, 21);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(8);
    expect(next!.getDate()).toBe(afterEnd.getDate() + 1);
  });

  it('handles a wrapping allowed window (22..6 = "evening + early morning")', () => {
    const insideWrap1 = new Date();
    insideWrap1.setHours(23, 0, 0, 0);
    expect(nextAllowedSendTime(insideWrap1, 22, 6)).toBeNull();
    const insideWrap2 = new Date();
    insideWrap2.setHours(3, 0, 0, 0);
    expect(nextAllowedSendTime(insideWrap2, 22, 6)).toBeNull();
    const outsideWrap = new Date();
    outsideWrap.setHours(12, 0, 0, 0);
    const next = nextAllowedSendTime(outsideWrap, 22, 6);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(22);
  });
});
