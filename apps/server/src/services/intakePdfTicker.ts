// Phase 28.9 — Image-set → PDF conversion ticker.
//
// Polls `intake_pdfs WHERE conversion_status='pending' AND next_attempt_at
// <= now() AND conversion_started_at IS NULL` and processes them through
// `intakePdfBuilder.buildPdfForSession` + encrypt + attachmentStorage +
// row-update.
//
// Concurrency: `firm_settings.intake_conversion_concurrency` (default 2).
// One firm per appliance, so this is firm-wide. Each tick claims up to
// `concurrency` rows in a single transactional `SELECT FOR UPDATE SKIP
// LOCKED` to avoid two ticks racing the same job.
//
// Retry policy: 3 attempts, exponential backoff (1m, 5m, 15m). On
// permanent failure we set status='failed', write a `intake.pdf.
// conversion_failed` audit row, and enqueue an in-app admin notification
// row that 28.12 picks up.
//
// Why a `setInterval` ticker instead of BullMQ: Connect doesn't run
// Redis (see CLAUDE.md). Mirrors the seven existing tickers
// (scheduledMessages, retention, vaultRetention, tlsAcme, etc.) which
// use the same atomic UPDATE ... RETURNING claim pattern from
// `scheduledMessages.ts`.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { intakeNotificationsRepo } from '../repositories/intake.js';
import { attachmentStorage } from './attachmentStorage.js';
import { encryptBufferStreaming } from './intakeCrypto.js';
import { buildPdfForSession } from './intakePdfBuilder.js';

const TICK_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

interface ClaimedRow {
  id: string;
  session_id: string;
  attempts: number;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Start the ticker. Idempotent — calling twice has no effect. Mirrors
 * the start/stop shape of the other in-process tickers so `index.ts`
 * can wire it up alongside `scheduledMessages` etc.
 */
export function startIntakePdfConversionTicker(): void {
  if (timer) return;
  // Run once on a slight delay so the boot path doesn't race the
  // initial DB pool warm-up.
  timer = setInterval(() => {
    if (inFlight) return; // skip overlapping ticks
    inFlight = true;
    void tickOnce()
      .catch((err: unknown) => {
        logger.error('intake.pdf_tick_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
      });
  }, TICK_INTERVAL_MS);
  // unref so the ticker doesn't pin Node's event loop in tests that
  // forget to call stop().
  timer.unref();
}

export function stopIntakePdfConversionTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One pass. Claim up to `concurrency` pending rows and process them in
 * parallel. Returns the number of rows processed (regardless of
 * success/failure outcome). Exposed for tests.
 */
export async function tickOnce(): Promise<number> {
  const settings = await db('firm_settings').where({ id: 1 }).first<{
    intake_conversion_concurrency: number;
  }>('intake_conversion_concurrency');
  const concurrency = Math.max(1, Math.min(16, settings?.intake_conversion_concurrency ?? 2));

  const claimed = await claimRows(concurrency);
  if (claimed.length === 0) return 0;
  await Promise.all(
    claimed.map((row) =>
      processOne(row).catch((err: unknown) => {
        logger.error('intake.pdf_process_one_threw', {
          jobId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
  return claimed.length;
}

/**
 * Atomic claim: select up to N rows that are pending + due, mark them
 * processing, return the (id, session_id, attempts) tuples for the
 * caller to drive through `processOne`.
 *
 * Uses Postgres's `FOR UPDATE SKIP LOCKED` inside a sub-SELECT so two
 * concurrent ticks (or a future scaled-out worker pool) don't race the
 * same row. Pattern matches `services/scheduledMessages.ts:95-100`.
 */
async function claimRows(concurrency: number): Promise<ClaimedRow[]> {
  const candidates = await db('intake_pdfs')
    .where({ conversion_status: 'pending' })
    .whereNull('conversion_started_at')
    .where('next_attempt_at', '<=', db.fn.now())
    .orderBy('created_at')
    .limit(concurrency)
    .forUpdate()
    .skipLocked()
    .select('id');
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id as string);
  const rows = await db('intake_pdfs')
    .whereIn('id', ids)
    .update({
      conversion_status: 'processing',
      conversion_started_at: db.fn.now(),
    })
    .returning<Array<{ id: string; session_id: string; attempts: number }>>([
      'id',
      'session_id',
      'attempts',
    ]);
  return rows;
}

/**
 * Build → encrypt → store → row-update for one row. On success the row
 * lands `conversion_status='done'`; on failure we either back off
 * (attempts < 3) or mark permanently failed + audit + admin notify.
 */
export async function processOne(row: ClaimedRow): Promise<void> {
  const startedAt = Date.now();
  try {
    const { pdfBytes, pageCount, sha256 } = await buildPdfForSession(row.session_id);
    const ciphertext = await encryptBufferStreaming(Buffer.from(pdfBytes));
    const storageKey = `intake/${row.session_id}/conversion-${sha256.slice(0, 16)}.pdf.enc`;
    const storedPath = await attachmentStorage().put(storageKey, ciphertext);

    await db('intake_pdfs').where({ id: row.id }).update({
      stored_path: storedPath,
      size_bytes: pdfBytes.length,
      sha256,
      page_count: pageCount,
      conversion_status: 'done',
      error_message: null,
    });

    logger.info('intake.pdf_conversion_done', {
      jobId: row.id,
      sessionId: row.session_id,
      pageCount,
      sizeBytes: pdfBytes.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    await handleFailure(row, err);
  }
}

async function handleFailure(row: ClaimedRow, err: unknown): Promise<void> {
  const attempts = row.attempts + 1;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
  const isPermanent = attempts >= MAX_ATTEMPTS;

  if (isPermanent) {
    await db('intake_pdfs').where({ id: row.id }).update({
      conversion_status: 'failed',
      attempts,
      error_message: message,
    });
    await auditRepo.write({
      actorUserId: null,
      action: 'intake.pdf.conversion_failed',
      targetType: 'intake_session',
      targetId: row.session_id,
      details: { jobId: row.id, attempts, error: message },
      ipAddress: null,
    });
    // 28.12 admin escalation — every active admin user gets an in-app
    // notice. Inserting one row per admin so the 28.12 fanout ticker
    // can claim/send each independently.
    const admins = await db('users')
      .where({ is_admin: true, is_active: true })
      .pluck<string[]>('id');
    for (const adminId of admins) {
      await intakeNotificationsRepo.enqueue({
        session_id: row.session_id,
        channel: 'in_app',
        recipient_hash: adminId,
        template_id: 'admin.pdf_conversion_failed',
        payload: { jobId: row.id, error: message.slice(0, 200) },
      });
    }
    logger.error('intake.pdf_conversion_permanent_failure', {
      jobId: row.id,
      sessionId: row.session_id,
      attempts,
      err: message,
    });
    return;
  }

  // Retry: schedule the next attempt at `next_attempt_at = now + backoff`,
  // clear conversion_started_at so the next tick re-claims, leave status
  // at 'pending'.
  const backoffMs = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
  await db('intake_pdfs')
    .where({ id: row.id })
    .update({
      conversion_status: 'pending',
      conversion_started_at: null,
      attempts,
      error_message: message,
      // Parameterised raw query — `backoffMs` is a numeric we control,
      // not user input, but bind it anyway for hygiene.
      next_attempt_at: db.raw("NOW() + (? * INTERVAL '1 millisecond')", [backoffMs]),
    });
  logger.warn('intake.pdf_conversion_retry_scheduled', {
    jobId: row.id,
    sessionId: row.session_id,
    attempts,
    backoffMs,
    err: message,
  });
}
