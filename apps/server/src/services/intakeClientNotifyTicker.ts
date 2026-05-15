// Phase 28.10 — Client receipt notification ticker.
//
// Polls `intake_notifications_outbox WHERE channel IN ('email','sms') AND
// status='pending' AND next_attempt_at <= now()` and sends each through
// the firm's configured email / SMS provider. Rows are enqueued by the
// 28.5 finalize endpoint with `recipient_hash` = the searchHash of the
// recipient address; this ticker re-derives the plaintext via the
// session's encrypted PII column so the bridge providers get an actual
// email or phone to deliver to.
//
// CRYPTO posture: plaintext PII touches memory only for the duration of
// the send call. The audit row written after each send carries the
// hashed recipient (no plaintext) — `hashForAudit(recipient)` re-hashes
// under the intake key, matching the rest of the 28 audit conventions.
//
// Quiet hours: SMS sends respect `firm_settings.sms_quiet_start_hour` /
// `sms_quiet_end_hour` (the same TCPA window the email/sms bridge uses).
// During the quiet window a row is marked `status='deferred'` with
// `next_attempt_at` = the next allowed hour boundary; the next tick
// re-picks it up. Email is sent immediately regardless of time.
//
// Retry: failed sends back off (1m, 5m, 15m). Permanent failure (3
// attempts) sets `status='failed'`, flips `intake_sessions.notification_failed
// = true` so the staff view in 28.11 surfaces it, and audits the per-channel
// failure.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { getSmsProvider } from '../bridges/sms/index.js';
import { decryptField } from './intakeCrypto.js';

const TICK_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startIntakeClientNotifyTicker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void tickOnce()
      .catch((err: unknown) => {
        logger.error('intake.client_notify_tick_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, TICK_INTERVAL_MS);
  timer.unref();
}

export function stopIntakeClientNotifyTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Process one tick — claim pending email/sms rows, dispatch each.
 * Exported for tests that drive the ticker without the setInterval.
 */
export async function tickOnce(): Promise<number> {
  const claimed = await claimRows();
  if (claimed.length === 0) return 0;
  // Sequential dispatch — bridge providers are often per-account
  // throttled (Postmark / Twilio both rate-limit), and walk-up intake
  // volume doesn't justify the complexity of a parallel send pool.
  for (const row of claimed) {
    await processOne(row).catch((err: unknown) => {
      logger.error('intake.client_notify_process_threw', {
        rowId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return claimed.length;
}

interface ClaimedNotificationRow {
  id: string;
  session_id: string | null;
  channel: 'email' | 'sms';
  template_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  recipient_hash: string;
}

async function claimRows(): Promise<ClaimedNotificationRow[]> {
  // Phase 28.10 owns `channel IN ('email','sms')` AND `template_id LIKE 'client.%'`
  // so it doesn't race the 28.12 staff ticker on email rows. SMS rows have
  // no staff template today, but the template-id filter still helps a
  // future grep distinguish.
  const candidates = await db('intake_notifications_outbox')
    .whereIn('channel', ['email', 'sms'])
    .whereRaw("template_id LIKE 'client.%'")
    .where({ status: 'pending' })
    .where('next_attempt_at', '<=', db.fn.now())
    .orderBy('created_at')
    .limit(20)
    .forUpdate()
    .skipLocked()
    .select('id');
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id as string);
  const rows = await db('intake_notifications_outbox')
    .whereIn('id', ids)
    .update({ status: 'sending' })
    .returning<ClaimedNotificationRow[]>([
      'id',
      'session_id',
      'channel',
      'template_id',
      'payload',
      'attempts',
      'recipient_hash',
    ]);
  return rows;
}

async function processOne(row: ClaimedNotificationRow): Promise<void> {
  // Session is required to look up the encrypted PII + the staff name.
  // A row with no session_id is malformed (audit emits a warning and the
  // row goes permanent-failed so the operator notices).
  if (!row.session_id) {
    await markFailed(row, 'no_session_id');
    return;
  }
  const session = await db('intake_sessions').where({ id: row.session_id }).first();
  if (!session) {
    await markFailed(row, 'session_missing');
    return;
  }

  const firm = await db('firm_settings').where({ id: 1 }).first<{
    firm_name: string;
    sms_quiet_start_hour: number;
    sms_quiet_end_hour: number;
  }>('firm_name', 'sms_quiet_start_hour', 'sms_quiet_end_hour');

  // SMS quiet-hours check. start_hour is the FIRST allowed hour, end_hour
  // is the FIRST disallowed hour (matches the firm_sms_quiet_hours
  // migration's intent — admin sets the *allowed* window 08:00–21:00).
  // Email is always-allowed.
  if (row.channel === 'sms') {
    const next = nextAllowedSendTime(
      new Date(),
      firm?.sms_quiet_start_hour ?? 8,
      firm?.sms_quiet_end_hour ?? 21,
    );
    if (next) {
      await db('intake_notifications_outbox')
        .where({ id: row.id })
        .update({
          status: 'deferred',
          next_attempt_at: next.toISOString(),
        });
      logger.info('intake.client_notify_deferred_quiet_hours', {
        rowId: row.id,
        sessionId: row.session_id,
        nextAttemptAt: next.toISOString(),
      });
      return;
    }
  }

  // Resolve the recipient address from the session's encrypted PII.
  try {
    if (row.channel === 'email') {
      if (!session.client_email_enc) {
        await markFailed(row, 'no_email_on_session');
        return;
      }
      const email = await decryptField(session.client_email_enc);
      const name = await decryptField(session.client_name_enc);
      const fileCount = Number(
        (row.payload as { file_count?: number }).file_count ?? 0,
      );
      const provider = await getEmailProvider();
      await provider.send(buildClientEmail(name, fileCount, firm?.firm_name ?? 'Firm', email));
    } else {
      if (!session.client_phone_enc) {
        await markFailed(row, 'no_phone_on_session');
        return;
      }
      const phone = await decryptField(session.client_phone_enc);
      const name = await decryptField(session.client_name_enc);
      const fileCount = Number(
        (row.payload as { file_count?: number }).file_count ?? 0,
      );
      const provider = await getSmsProvider();
      await provider.sendMessage(buildClientSms(name, fileCount, firm?.firm_name ?? 'Firm', phone));
    }
  } catch (err) {
    await scheduleRetry(row, err);
    return;
  }

  // Success path.
  await db('intake_notifications_outbox').where({ id: row.id }).update({
    status: 'sent',
    sent_at: db.fn.now(),
    last_error: null,
  });
  await auditRepo
    .write({
      actorUserId: null,
      action: 'intake.client_notification.sent',
      targetType: 'intake_session',
      targetId: row.session_id,
      details: {
        channel: row.channel,
        recipient_hash: row.recipient_hash,
        template_id: row.template_id,
      },
      ipAddress: null,
    })
    .catch(() => {
      /* audit failure shouldn't fail the send */
    });
  logger.info('intake.client_notify_sent', {
    rowId: row.id,
    sessionId: row.session_id,
    channel: row.channel,
  });
}

async function scheduleRetry(row: ClaimedNotificationRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(row, message);
    return;
  }
  const backoffMs = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
  await db('intake_notifications_outbox')
    .where({ id: row.id })
    .update({
      status: 'pending',
      attempts,
      last_error: message,
      next_attempt_at: db.raw('NOW() + (? * INTERVAL \'1 millisecond\')', [backoffMs]),
    });
  logger.warn('intake.client_notify_retry', {
    rowId: row.id,
    sessionId: row.session_id,
    channel: row.channel,
    attempts,
    backoffMs,
    err: message,
  });
}

async function markFailed(row: ClaimedNotificationRow, reason: string): Promise<void> {
  await db('intake_notifications_outbox').where({ id: row.id }).update({
    status: 'failed',
    attempts: row.attempts + 1,
    last_error: reason,
  });
  // Per-channel detail is in the audit row; the row-level flag on
  // intake_sessions just tells the staff view "at least one notification
  // failed" so they know to check.
  if (row.session_id) {
    await db('intake_sessions').where({ id: row.session_id }).update({ notification_failed: true });
  }
  await auditRepo
    .write({
      actorUserId: null,
      action: 'intake.client_notification.failed',
      targetType: 'intake_session',
      targetId: row.session_id,
      details: {
        channel: row.channel,
        template_id: row.template_id,
        recipient_hash: row.recipient_hash,
        reason: reason.slice(0, 200),
      },
      ipAddress: null,
    })
    .catch(() => {
      /* audit failure shouldn't loop the retry */
    });
  logger.error('intake.client_notify_permanent_failure', {
    rowId: row.id,
    sessionId: row.session_id,
    channel: row.channel,
    reason,
  });
}

// -------- helpers --------

/**
 * Given the current time and the allowed-window hours, return null if
 * sending is allowed right now, or the Date when the next allowed
 * window starts.
 *
 * Both hour args are 0..23. The allowed window is [start, end) in the
 * server's local time; SMS-bridge quiet-hours are recipient-tz-aware
 * (`external_identities.preferences.timezone`) but anonymous intake
 * clients have no recorded TZ — falling back to server-local is the
 * deliberate trade-off here.
 */
export function nextAllowedSendTime(
  now: Date,
  startHour: number,
  endHour: number,
): Date | null {
  const hour = now.getHours();
  if (startHour < endHour) {
    // Simple window: e.g. 8..21 — allowed when 8 <= hour < 21.
    if (hour >= startHour && hour < endHour) return null;
    const next = new Date(now);
    if (hour < startHour) {
      next.setHours(startHour, 0, 0, 0);
    } else {
      // hour >= endHour: wait until tomorrow's startHour.
      next.setDate(next.getDate() + 1);
      next.setHours(startHour, 0, 0, 0);
    }
    return next;
  }
  // Wrapping window (e.g. start=22, end=6) — allowed when hour >= start OR hour < end.
  if (hour >= startHour || hour < endHour) return null;
  const next = new Date(now);
  next.setHours(startHour, 0, 0, 0);
  return next;
}

interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function buildClientEmail(
  name: string,
  fileCount: number,
  firmName: string,
  to: string,
): EmailMessage {
  // Plain-text body. Per the build plan: file count + the explicit "if
  // this wasn't you" line. NO download link, no session id, no file
  // names — the staff view in 28.11 is where the file metadata lives.
  const text = [
    `Hi ${name},`,
    '',
    `${firmName} received your ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
    '',
    `If this wasn't you, please contact ${firmName} directly.`,
    '',
    `Thanks,`,
    `${firmName}`,
  ].join('\n');
  return {
    to,
    subject: 'We received your files',
    text,
  };
}

interface SmsSendRequest {
  to: string;
  body: string;
}

function buildClientSms(
  name: string,
  fileCount: number,
  firmName: string,
  to: string,
): SmsSendRequest {
  // Single SMS segment when possible (160 chars). The "Reply STOP to
  // opt out" tail satisfies the TCPA / 10DLC consent message convention.
  const body = `Hi ${name}, ${firmName} received your ${fileCount} file${fileCount === 1 ? '' : 's'}. Reply STOP to opt out.`;
  return { to, body };
}

