// Phase 28.12 — Staff notification ticker (email + in-app).
//
// Polls `intake_notifications_outbox WHERE channel IN ('email', 'in_app')
// AND status='pending' AND next_attempt_at <= now()`.
//
//   email  → getEmailProvider().send() with the "New intake from [name]"
//            template. Deep link to /app/intake?session=:id.
//   in_app → publish('intake.session.received') on the pgFanout. The
//            staff SPA's existing realtime listener bumps an unread
//            badge in `apps/web/src/state/notifications.ts`.
//
// Distinct from the client notify ticker (28.10) because the channel
// set, template shapes, and recipient resolution all differ:
//   - Staff email recipient is `users.email` keyed off
//     `recipient_hash = staff_id` (string equality, not a hash).
//   - In-app notice is realtime, not a stored message.
//   - Admin-escalation template (admin.pdf_conversion_failed) is also
//     handled here — same fanout channel + audit shape.
//
// Per-staff preferences ("Email me for every intake" vs "Daily digest"
// vs "In-app only") + digest mode are honored via users.intake_notify_mode
// (added in migration 20260515000001):
//   - realtime: send email + in_app immediately (default).
//   - digest:   email rows deferred to next firm-local digest hour, then
//               aggregated per user into a single summary message;
//               in_app remains realtime so the staff still sees an
//               unread badge update.
//   - in_app_only: skip email entirely (row marked 'sent' with a no-op
//                  reason in last_error); in_app remains realtime.
// in_app rows are never deferred — digest is an email batching mechanism.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { decryptField } from './intakeCrypto.js';
import { publish } from '../realtime/pgFanout.js';

const TICK_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startIntakeStaffNotifyTicker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void tickOnce()
      .catch((err: unknown) => {
        logger.error('intake.staff_notify_tick_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, TICK_INTERVAL_MS);
  timer.unref();
}

export function stopIntakeStaffNotifyTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

interface StaffRow {
  id: string;
  session_id: string | null;
  channel: 'email' | 'in_app';
  template_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  recipient_hash: string;
}

export type NotifyMode = 'realtime' | 'digest' | 'in_app_only';

export async function tickOnce(): Promise<number> {
  // Phase 28.12 owns rows where channel ∈ {email,in_app} AND the
  // template_id is a staff/admin one. The 28.10 client ticker filters
  // for `template_id LIKE 'client.%'` symmetrically, so a single email
  // row can never be claimed by both — they tile rather than race.
  //
  // First: process deferred rows whose `next_attempt_at` has matured.
  // These are digest-mode emails the ticker decided to batch; at the
  // digest hour we flush them per-user. Run BEFORE the pending pass so
  // a digest that just matured doesn't compete with newly-pending rows
  // for the same per-user batch.
  await flushDigests();

  const candidates = await db('intake_notifications_outbox')
    .whereIn('channel', ['email', 'in_app'])
    .whereRaw("(template_id LIKE 'staff.%' OR template_id LIKE 'admin.%')")
    .where({ status: 'pending' })
    .where('next_attempt_at', '<=', db.fn.now())
    .orderBy('created_at')
    .limit(20)
    .forUpdate()
    .skipLocked()
    .select('id');
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.id as string);
  const rows = await db('intake_notifications_outbox')
    .whereIn('id', ids)
    .update({ status: 'sending' })
    .returning<
      StaffRow[]
    >(['id', 'session_id', 'channel', 'template_id', 'payload', 'attempts', 'recipient_hash']);
  for (const row of rows) {
    await processOne(row).catch((err: unknown) => {
      logger.error('intake.staff_notify_process_threw', {
        rowId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return rows.length;
}

async function processOne(row: StaffRow): Promise<void> {
  // `recipient_hash` on staff-channel rows is the staff user_id (not a
  // hash) — the 28.5 finalize + 28.9 admin-escalation enqueue both pass
  // the user_id directly there. Look up the user record to resolve email
  // + display_name + intake_notify_mode for the routing decision.
  const user = (await db('users')
    .where({ id: row.recipient_hash })
    .first<
      UserRow & { is_active: boolean; intake_notify_mode: string }
    >(['id', 'email', 'display_name', 'is_active', 'intake_notify_mode'])) as
    | (UserRow & { is_active: boolean; intake_notify_mode: NotifyMode })
    | undefined;
  if (!user) {
    await markFailed(row, 'recipient_user_missing');
    return;
  }
  if (!user.is_active) {
    // Active recipients only — deactivated users don't get pinged.
    await markFailed(row, 'recipient_deactivated');
    return;
  }

  // Preference routing for EMAIL rows only — in_app rows are always
  // realtime regardless of `intake_notify_mode`. Admin-escalation emails
  // (`admin.pdf_conversion_failed`) ALSO bypass the preference: a
  // failed PDF conversion needs immediate attention, not a digest.
  if (
    row.channel === 'email' &&
    !row.template_id.startsWith('admin.') &&
    user.intake_notify_mode === 'in_app_only'
  ) {
    await db('intake_notifications_outbox').where({ id: row.id }).update({
      status: 'sent',
      sent_at: db.fn.now(),
      last_error: 'skipped_by_preference:in_app_only',
    });
    logger.info('intake.staff_notify_skipped_in_app_only', { rowId: row.id });
    return;
  }
  if (
    row.channel === 'email' &&
    !row.template_id.startsWith('admin.') &&
    user.intake_notify_mode === 'digest'
  ) {
    await deferToDigest(row);
    return;
  }

  try {
    if (row.channel === 'in_app') {
      await sendInApp(row, user.id as string);
    } else {
      await sendEmail(row, user);
    }
  } catch (err) {
    await scheduleRetry(row, err);
    return;
  }

  await db('intake_notifications_outbox').where({ id: row.id }).update({
    status: 'sent',
    sent_at: db.fn.now(),
    last_error: null,
  });
  await auditRepo
    .write({
      actorUserId: null,
      action: 'intake.staff_notification.sent',
      targetType: row.session_id ? 'intake_session' : 'intake_card',
      targetId: row.session_id ?? row.recipient_hash,
      details: {
        channel: row.channel,
        recipient_user_id: row.recipient_hash,
        template_id: row.template_id,
      },
      ipAddress: null,
    })
    .catch((err) => {
      // Send succeeded; audit-table gap would otherwise look identical to
      // "never sent" — log so forensics can correlate.
      logger.warn('intake.staff_notify_audit_write_failed', {
        rowId: row.id,
        channel: row.channel,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  logger.info('intake.staff_notify_sent', {
    rowId: row.id,
    channel: row.channel,
    template: row.template_id,
  });
}

async function sendInApp(row: StaffRow, userId: string): Promise<void> {
  if (!row.session_id) {
    throw new Error('in_app intake notification requires session_id');
  }
  const fileCount = Number((row.payload as { file_count?: number }).file_count ?? 0);
  await publish({
    type: 'intake.session.received',
    userId,
    sessionId: row.session_id,
    fileCount,
    createdAt: new Date().toISOString(),
  });
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
}

async function sendEmail(row: StaffRow, user: UserRow): Promise<void> {
  if (!user.email) {
    throw new Error('staff_user_has_no_email');
  }
  const firm = await db('firm_settings').where({ id: 1 }).first<{ firm_name: string }>('firm_name');
  const firmName = firm?.firm_name ?? 'Vibe Connect';
  const fileCount = Number((row.payload as { file_count?: number }).file_count ?? 0);

  const template = row.template_id;
  let subject: string;
  let text: string;
  if (template === 'admin.pdf_conversion_failed') {
    // 28.9 admin-escalation template. Distinct copy + subject so an
    // admin reading the inbox sees "this needs my attention" vs a
    // routine new-intake alert.
    const errMsg = (row.payload as { error?: string }).error ?? 'unknown error';
    subject = `[Action needed] Intake PDF conversion failed`;
    text = [
      `Hi ${user.display_name},`,
      '',
      `An intake PDF conversion failed permanently after 3 attempts.`,
      `Error: ${String(errMsg).slice(0, 200)}`,
      '',
      `Open the intake admin view to investigate:`,
      `  ${firmName} → Admin → Intake → session ${row.session_id ?? '(unknown)'}`,
      '',
      `— ${firmName}`,
    ].join('\n');
  } else {
    // Default: new-intake email. We decrypt the client name for the
    // body — it's the single useful piece of context a busy staff
    // member needs to triage. Plain text only.
    let clientName = '(unavailable)';
    if (row.session_id) {
      const session = await db('intake_sessions').where({ id: row.session_id }).first();
      if (session?.client_name_enc) {
        try {
          clientName = await decryptField(session.client_name_enc);
        } catch {
          /* keep placeholder */
        }
      }
    }
    subject = `New intake from ${clientName} — ${fileCount} file${fileCount === 1 ? '' : 's'}`;
    text = [
      `Hi ${user.display_name},`,
      '',
      `${clientName} just submitted ${fileCount} file${fileCount === 1 ? '' : 's'} via the intake page.`,
      '',
      `Open the intake admin view:`,
      `  ${firmName} → Admin → Intake → session ${row.session_id ?? ''}`,
      '',
      `— ${firmName}`,
    ].join('\n');
  }

  const provider = await getEmailProvider();
  await provider.send({ to: user.email, subject, text });
}

async function scheduleRetry(row: StaffRow, err: unknown): Promise<void> {
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
      next_attempt_at: db.raw("NOW() + (? * INTERVAL '1 millisecond')", [backoffMs]),
    });
  logger.warn('intake.staff_notify_retry', {
    rowId: row.id,
    channel: row.channel,
    attempts,
    backoffMs,
    err: message,
  });
}

/**
 * Compute the next digest-flush moment in server-local time. Returns a
 * Date for today at `digestHour:00:00` if that's in the future, otherwise
 * tomorrow at the same hour. The ticker uses this both for deferring
 * email rows and for the `next_attempt_at` retry clock.
 */
function nextDigestAt(digestHour: number, now: Date = new Date()): Date {
  const candidate = new Date(now);
  candidate.setHours(digestHour, 0, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * Park an email row for the next digest flush. Sets `status='deferred'`
 * + `next_attempt_at = next digest hour`. The matured-deferred sweep in
 * `flushDigests` picks it up at the appointed time and batches with
 * other deferred rows for the same recipient.
 */
async function deferToDigest(row: StaffRow): Promise<void> {
  const firm = await db('firm_settings')
    .where({ id: 1 })
    .first<{ intake_digest_hour_local: number }>('intake_digest_hour_local');
  const digestHour = firm?.intake_digest_hour_local ?? 8;
  const next = nextDigestAt(digestHour);
  await db('intake_notifications_outbox').where({ id: row.id }).update({
    status: 'deferred',
    next_attempt_at: next.toISOString(),
    last_error: 'awaiting_digest_window',
  });
  logger.info('intake.staff_notify_deferred_digest', {
    rowId: row.id,
    recipient: row.recipient_hash,
    nextAttemptAt: next.toISOString(),
  });
}

/**
 * Flush deferred digest emails. Aggregates ALL deferred email rows per
 * recipient into a single summary email, sends, marks all rows sent.
 * Called at the top of `tickOnce` so it runs every TICK_INTERVAL_MS;
 * the natural rate limiter is `next_attempt_at`, which the deferral
 * step pins to the firm's digest hour.
 *
 * Idempotent: if no rows are matured, returns immediately. If the send
 * fails, the rows stay deferred and the next tick retries.
 */
async function flushDigests(): Promise<void> {
  // Claim all matured deferred rows in one go. Group by recipient
  // BEFORE flipping status so a concurrent enqueue between SELECT and
  // UPDATE doesn't get picked up here.
  const candidates = (await db('intake_notifications_outbox')
    .where({ status: 'deferred', channel: 'email' })
    .whereRaw("(template_id LIKE 'staff.%' OR template_id LIKE 'admin.%')")
    .where('next_attempt_at', '<=', db.fn.now())
    .forUpdate()
    .skipLocked()
    .limit(1000)
    .select<
      Array<{
        id: string;
        session_id: string | null;
        recipient_hash: string;
        template_id: string;
        payload: Record<string, unknown>;
        attempts: number;
      }>
    >(['id', 'session_id', 'recipient_hash', 'template_id', 'payload', 'attempts'])) as Array<{
    id: string;
    session_id: string | null;
    recipient_hash: string;
    template_id: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>;
  if (candidates.length === 0) return;

  // Group by recipient user_id.
  const byRecipient = new Map<string, typeof candidates>();
  for (const r of candidates) {
    const arr = byRecipient.get(r.recipient_hash) ?? [];
    arr.push(r);
    byRecipient.set(r.recipient_hash, arr);
  }

  await db('intake_notifications_outbox')
    .whereIn(
      'id',
      candidates.map((c) => c.id),
    )
    .update({ status: 'sending' });

  const firm = await db('firm_settings').where({ id: 1 }).first<{
    firm_name: string;
    intake_digest_hour_local: number;
  }>('firm_name', 'intake_digest_hour_local');
  const firmName = firm?.firm_name ?? 'Vibe Connect';

  for (const [userId, rows] of byRecipient) {
    const user = await db('users').where({ id: userId }).first<{
      id: string;
      email: string | null;
      display_name: string;
      is_active: boolean;
    }>(['id', 'email', 'display_name', 'is_active']);
    if (!user || !user.email || !user.is_active) {
      // Mark each row failed with a clear reason rather than retrying
      // forever. An admin can see the trail in the audit viewer.
      for (const r of rows) {
        await markFailed(
          r as StaffRow,
          !user
            ? 'recipient_user_missing'
            : !user.is_active
              ? 'recipient_deactivated'
              : 'staff_user_has_no_email',
        );
      }
      continue;
    }

    // Build the digest body. List one line per session with file count;
    // collapse admin-escalation rows that may have snuck in (rare —
    // admin.* rows bypass the digest branch, but defence in depth).
    const lines: string[] = [];
    let totalFiles = 0;
    let totalSessions = 0;
    for (const r of rows) {
      const fc = Number((r.payload as { file_count?: number }).file_count ?? 0);
      totalFiles += fc;
      if (r.session_id) {
        totalSessions += 1;
        lines.push(`  • session ${r.session_id.slice(0, 8)} — ${fc} file${fc === 1 ? '' : 's'}`);
      }
    }

    const subject = `Daily intake digest — ${totalSessions} new submission${
      totalSessions === 1 ? '' : 's'
    } (${totalFiles} file${totalFiles === 1 ? '' : 's'})`;
    const text = [
      `Hi ${user.display_name},`,
      '',
      `${firmName} received ${totalSessions} new intake submission${
        totalSessions === 1 ? '' : 's'
      } since the last digest:`,
      '',
      ...lines,
      '',
      `Open the intake admin view to triage:`,
      `  ${firmName} → Admin → Intake`,
      '',
      `(You're receiving this digest because your intake notification`,
      `preference is set to "Daily digest". Change it in Account → Intake card.)`,
      '',
      `— ${firmName}`,
    ].join('\n');

    try {
      const provider = await getEmailProvider();
      await provider.send({ to: user.email, subject, text });
      await db('intake_notifications_outbox')
        .whereIn(
          'id',
          rows.map((r) => r.id),
        )
        .update({ status: 'sent', sent_at: db.fn.now(), last_error: null });
      await auditRepo
        .write({
          actorUserId: null,
          action: 'intake.staff_notification.sent',
          targetType: 'intake_card',
          targetId: userId,
          details: {
            channel: 'email',
            mode: 'digest',
            recipient_user_id: userId,
            template_id: 'staff.digest',
            session_count: totalSessions,
            file_count: totalFiles,
            row_ids: rows.map((r) => r.id),
          },
          ipAddress: null,
        })
        .catch((err) => {
          logger.warn('intake.staff_notify_digest_audit_write_failed', {
            userId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      logger.info('intake.staff_notify_digest_sent', {
        userId,
        sessionCount: totalSessions,
        fileCount: totalFiles,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      // Reset to deferred for next-tick retry. Bump attempts on each
      // row so the existing MAX_ATTEMPTS escalation path still applies.
      const next = nextDigestAt(firm?.intake_digest_hour_local ?? 8);
      await db('intake_notifications_outbox')
        .whereIn(
          'id',
          rows.map((r) => r.id),
        )
        .update({
          status: 'deferred',
          attempts: db.raw('attempts + 1'),
          last_error: message,
          next_attempt_at: next.toISOString(),
        });
      logger.warn('intake.staff_notify_digest_send_failed', {
        userId,
        err: message,
      });
    }
  }
}

async function markFailed(row: StaffRow, reason: string): Promise<void> {
  await db('intake_notifications_outbox')
    .where({ id: row.id })
    .update({
      status: 'failed',
      attempts: row.attempts + 1,
      last_error: reason,
    });
  await auditRepo
    .write({
      actorUserId: null,
      action: 'intake.staff_notification.failed',
      targetType: row.session_id ? 'intake_session' : 'intake_card',
      targetId: row.session_id ?? row.recipient_hash,
      details: {
        channel: row.channel,
        template_id: row.template_id,
        recipient_user_id: row.recipient_hash,
        reason: reason.slice(0, 200),
      },
      ipAddress: null,
    })
    .catch((err) => {
      logger.warn('intake.staff_notify_failure_audit_write_failed', {
        rowId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  logger.error('intake.staff_notify_permanent_failure', {
    rowId: row.id,
    channel: row.channel,
    reason,
  });
}
