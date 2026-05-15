// Phase 28.15 — Intake auto-purge ticker.
//
// Hourly sweep: any `intake_sessions` row whose `auto_delete_at` has
// passed AND whose status is 'finalized' gets hard-deleted along with
// every on-disk artifact (encrypted file blobs + assembled PDF). The
// audit row written BEFORE the delete survives by construction — it
// lives in the global `audit_log` table with no FK back to the intake
// schema (CLAUDE.md: "Reuse `audit_log` ... action names: `intake.*`").
//
// Mirrors services/vaultRetention.ts pacing: setTimeout for the first
// sweep (60s after boot) so a freshly-launched container doesn't have
// to wait a full hour before catching up on backlog; setInterval at
// TICK_MS thereafter. unref()'d timers so shutdown doesn't hang.
//
// Auto-delete is OFF by default — sessions only acquire an
// `auto_delete_at` value when (a) the firm setting was enabled at
// finalize time, or (b) an admin flipped it on and the backfill helper
// (`applyRetentionBackfill`) ran. A session whose `auto_delete_at IS
// NULL` is permanent until the firm setting changes or an admin
// explicitly deletes it via 28.11's session-detail surface.
//
// Production calls `startIntakeAutoPurgeTicker()` from index.ts; tests
// drive `runIntakeAutoPurgeSweep()` directly.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { attachmentStorage } from './attachmentStorage.js';

const TICK_MS = 60 * 60 * 1000; // hourly
let ticker: NodeJS.Timeout | null = null;

export interface IntakeAutoPurgeResult {
  sessionsPurged: number;
  filesDeleted: number;
  pdfsDeleted: number;
  errors: number;
}

export function startIntakeAutoPurgeTicker(): void {
  if (ticker) return;
  setTimeout(() => {
    void runIntakeAutoPurgeSweep().catch((err) => {
      logger.error('intake_auto_purge.first_tick_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, 60_000).unref();
  ticker = setInterval(() => {
    void runIntakeAutoPurgeSweep().catch((err) => {
      logger.error('intake_auto_purge.tick_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, TICK_MS);
  ticker.unref();
}

export function stopIntakeAutoPurgeTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Per-tick batch size. The sweep processes sessions in chunks so a
 * sudden retention-cliff (e.g. an admin enables auto-delete + sets
 * 30 days against a year of accumulated sessions) doesn't melt the
 * disk in a single tick. Subsequent ticks pick up the remainder.
 */
const BATCH_SIZE = 200;

export async function runIntakeAutoPurgeSweep(): Promise<IntakeAutoPurgeResult> {
  const result: IntakeAutoPurgeResult = {
    sessionsPurged: 0,
    filesDeleted: 0,
    pdfsDeleted: 0,
    errors: 0,
  };

  // Claim a batch of overdue sessions. We deliberately fetch the row
  // ids first then process one-at-a-time so an error on one session's
  // disk delete doesn't abort the others. Skipping `status != finalized`
  // also gates this: never auto-purge an in-flight ('open') session,
  // and an 'expired' or 'abandoned' session has no settled files
  // worth treating as "client receipt" yet — those clean up via the
  // separate orphan reaper (TODO(phase28.17)) not this ticker.
  const candidates = (await db('intake_sessions')
    .where('status', 'finalized')
    .whereNotNull('auto_delete_at')
    .where('auto_delete_at', '<=', db.fn.now())
    .orderBy('auto_delete_at', 'asc')
    .limit(BATCH_SIZE)
    .pluck('id')) as string[];

  if (candidates.length === 0) return result;

  const storage = attachmentStorage();

  for (const sessionId of candidates) {
    try {
      // Snapshot the session + dependent on-disk paths BEFORE we audit
      // or delete. Order matters: audit row must land before delete so
      // the forensic trail exists, but we need the file paths in hand
      // before we lose them to cascade.
      const session = await db('intake_sessions').where({ id: sessionId }).first();
      if (!session) continue; // raced with a manual delete — fine.

      const files = (await db('intake_files')
        .where({ session_id: sessionId })
        .select<
          Array<{ id: string; stored_path: string; size_bytes: string | number }>
        >('id', 'stored_path', 'size_bytes')) as Array<{
        id: string;
        stored_path: string;
        size_bytes: string | number;
      }>;
      const pdf = await db('intake_pdfs').where({ session_id: sessionId }).first<{
        id: string;
        stored_path: string | null;
        size_bytes: string | number | null;
      }>(['id', 'stored_path', 'size_bytes']);

      const totalBytes =
        files.reduce((sum, f) => sum + Number(f.size_bytes), 0) +
        (pdf?.size_bytes ? Number(pdf.size_bytes) : 0);

      // Audit FIRST — if the audit write fails we abort the delete so
      // we never silently destroy data without a row to point at it.
      await auditRepo.write({
        actorUserId: null,
        action: 'intake.session.auto_purged',
        targetType: 'intake_session',
        targetId: sessionId,
        details: {
          staff_id: session.staff_id,
          finalized_at: session.finalized_at,
          auto_delete_at: session.auto_delete_at,
          file_count: files.length,
          total_bytes: totalBytes,
          pdf_present: Boolean(pdf?.stored_path),
        },
        ipAddress: null,
      });

      // Delete on-disk blobs. attachmentStorage.delete swallows ENOENT
      // so a partial state (file already gone, row still there) doesn't
      // block the row delete. Track per-session errors so we can SKIP
      // the row delete on failure: leaving the row gives the next sweep
      // a chance to retry the blob delete, rather than orphaning the
      // on-disk ciphertext with no DB pointer.
      let perSessionErrors = 0;
      for (const f of files) {
        try {
          await storage.delete(f.stored_path);
          result.filesDeleted += 1;
        } catch (err) {
          logger.warn('intake_auto_purge.file_delete_failed', {
            sessionId,
            fileId: f.id,
            storedPath: f.stored_path,
            err: err instanceof Error ? err.message : String(err),
          });
          result.errors += 1;
          perSessionErrors += 1;
        }
      }
      if (pdf?.stored_path) {
        try {
          await storage.delete(pdf.stored_path);
          result.pdfsDeleted += 1;
        } catch (err) {
          logger.warn('intake_auto_purge.pdf_delete_failed', {
            sessionId,
            pdfId: pdf.id,
            storedPath: pdf.stored_path,
            err: err instanceof Error ? err.message : String(err),
          });
          result.errors += 1;
          perSessionErrors += 1;
        }
      }

      if (perSessionErrors > 0) {
        // At least one blob delete failed for a non-ENOENT reason. Skip
        // the row delete so the next hourly sweep can retry the disk
        // ops — otherwise we'd orphan ciphertext on disk with no DB
        // pointer. The audit row above is already written; an admin
        // grepping `intake_auto_purge.file_delete_failed` warnings can
        // correlate to the un-purged session.
        logger.warn('intake_auto_purge.session_retained_due_to_blob_failures', {
          sessionId,
          perSessionErrors,
        });
        continue;
      }

      // Cascade handles intake_files, intake_pdfs,
      // intake_uploads_in_progress, intake_notifications_outbox, and
      // intake_session_archives — all of which ON DELETE CASCADE on
      // session_id per the 28.1 migration.
      await db('intake_sessions').where({ id: sessionId }).del();
      result.sessionsPurged += 1;
    } catch (err) {
      logger.error('intake_auto_purge.session_failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      result.errors += 1;
    }
  }

  if (result.sessionsPurged > 0 || result.errors > 0) {
    logger.info('intake_auto_purge.sweep_complete', { ...result });
  }
  return result;
}

/**
 * Backfill helper called when the firm flips `intake_auto_delete_enabled`
 * from false → true. For every finalized session where `auto_delete_at`
 * is NULL we set it to MAX(now() + 7d, finalized_at + N days) so a
 * sudden setting change can't immediately purge a backlog of overdue
 * sessions — they get at least a 7-day grace window for the admin to
 * notice the configuration change and roll it back.
 *
 * Idempotent: only touches rows whose auto_delete_at is currently NULL.
 * Open / expired / abandoned sessions are skipped (auto-purge ignores
 * those anyway).
 */
export async function applyRetentionBackfill(afterDays: number): Promise<{ touched: number }> {
  const intervalStr = `${afterDays} days`;
  const rows = await db.raw<{ rowCount: number }>(
    `UPDATE intake_sessions
       SET auto_delete_at = GREATEST(
         NOW() + INTERVAL '7 days',
         finalized_at + (?::text || ' days')::interval
       )
     WHERE status = 'finalized'
       AND auto_delete_at IS NULL
       AND finalized_at IS NOT NULL`,
    [String(afterDays)],
  );
  void intervalStr;
  // Knex raw returns the pg result; the row count lives at .rowCount.
  const touched = (rows as unknown as { rowCount: number }).rowCount ?? 0;
  return { touched };
}

/**
 * Companion to applyRetentionBackfill: when the firm flips auto-delete
 * OFF, we clear `auto_delete_at` on every session so a previously-
 * scheduled purge can't fire after the policy was switched off. Per-
 * session "keep indefinitely" override rows are already NULL so they're
 * untouched.
 *
 * Sessions with a future or past auto_delete_at are both cleared — "off
 * means off" per the 28.15 build plan.
 */
export async function clearAllAutoDeleteAt(): Promise<{ touched: number }> {
  const result = await db('intake_sessions')
    .whereNotNull('auto_delete_at')
    .update({ auto_delete_at: null });
  return { touched: Number(result) };
}
