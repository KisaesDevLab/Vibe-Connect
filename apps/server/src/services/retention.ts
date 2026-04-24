// Retention enforcement: crypto-shreds messages and deletes their attachments
// once they age past the firm's configured `retention_days`. Destroying the
// ciphertext + attachment blobs is sufficient because the keys wrapped in
// `conversation_keys` remain, but are useless without readable ciphertext.
//
// Policy lookup is dynamic: admins can change `retention_days` via
// PATCH /admin/settings without restarting the appliance.
import type { Knex } from 'knex';
import { db as defaultDb } from '../db/knex.js';
import { logger } from '../logger.js';
import { attachmentStorage } from './attachmentStorage.js';
// Note: attachments + messages tables are accessed directly via knex here
// because retention's hot path is the bulk UPDATE/DELETE variants, not the
// per-row repository methods used by the write-paths.

interface RetentionResult {
  retentionDays: number | null;
  messagesShredded: number;
  attachmentsDeleted: number;
}

/**
 * Single sweep. Returns counts so a caller can surface them in an audit row
 * or skip logging when idle.
 *
 * The `dbOverride` parameter is a test seam — production calls pass no
 * argument and use the shared knex instance, tests can inject a proxied or
 * mock knex to exercise failure branches without patching the module's live
 * binding via Object.defineProperty.
 */
export async function runRetentionSweep(dbOverride?: Knex): Promise<RetentionResult> {
  const db = dbOverride ?? defaultDb;
  // Idempotency cleanup runs in its own try/catch so a hiccup on that table
  // (unique-index issue, lock contention during a bulk import) doesn't abort
  // the whole retention pass. Retention of client content is the critical
  // part of this sweep; idempotency bookkeeping is housekeeping.
  try {
    // 24-hour hard expiry regardless of retention policy — the table
    // shouldn't grow forever even with retention off.
    await db('idempotency_keys').where('created_at', '<', db.raw(`NOW() - INTERVAL '24 hours'`)).del();
    // Stuck placeholder rows: the claim INSERT writes `{}` into `response`
    // and the follow-up UPDATE replaces it with the real response body. If
    // the owning request crashes between those two statements, the slot
    // sits at `{}` and every subsequent retry on that key hits the 409
    // "in flight" branch for up to 24h. Garbage-collect any placeholder
    // older than 5 minutes so retries can proceed. The message_id NULL
    // check is the stuck signal — the update always fills it in.
    await db('idempotency_keys')
      .whereNull('message_id')
      .where('created_at', '<', db.raw(`NOW() - INTERVAL '5 minutes'`))
      .del();
  } catch (err) {
    logger.warn('retention.idempotency_cleanup_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const row = await db('firm_settings').where({ id: 1 }).first();
  const retentionDays = (row?.retention_days ?? null) as number | null;
  if (!retentionDays || retentionDays <= 0) {
    return { retentionDays, messagesShredded: 0, attachmentsDeleted: 0 };
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const store = attachmentStorage();
  let attachmentsDeleted = 0;
  let messagesShredded = 0;
  // Paginated scan + shred. The pre-fix version read every matching id into
  // memory in one SELECT, which is fine for a few thousand rows but blows up
  // on a first-run sweep over years of accumulated messages (hundreds of
  // thousands of uuids is ~20 MB of JS strings plus the pg driver's row
  // buffer). Instead we loop: SELECT one page, process it (tx + post-commit
  // blob cleanup), next iteration's SELECT naturally skips the ids we just
  // shredded because the WHERE octet_length(ciphertext) > 0 filter excludes
  // zero-length rows. This converges: each iteration reduces the set and the
  // loop ends when no matching rows remain.
  //
  // A retention window shorter than a scheduled_for delta would otherwise
  // crypto-shred the message before it ever became visible — rare given
  // typical retention is weeks to months but entirely possible for a 1-day
  // retention + 2-day scheduled send. The scheduled_for clause guards it.
  const BATCH_SIZE = 100;
  // Safety cap on loop iterations so a broken filter can't spin indefinitely.
  // 100k messages per sweep is already a lot; real firms are orders of
  // magnitude below that. If we stop at the cap AND the last batch was full
  // we warn — that's the signal the backlog probably isn't drained and the
  // next tick will continue. A partial final batch means we likely finished
  // naturally and the cap coincidence is harmless.
  const MAX_ITERATIONS = 1000;
  let stoppedAtCapWithFullBatch = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const batch = await db('messages')
      .where('created_at', '<', cutoff)
      .andWhereRaw('octet_length(ciphertext) > 0')
      .andWhere((b) => b.whereNull('scheduled_for').orWhere('scheduled_for', '<=', db.fn.now()))
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE)
      .select('id');
    if (batch.length === 0) break;
    const batchIds = batch.map((m) => m.id as string);
    // Wrap the batch in a transaction so the DB state is internally
    // consistent: either attachment rows are gone AND message ciphertext is
    // shredded, or neither. Storage-driver (filesystem / S3) deletes can't
    // participate in the transaction — they're best-effort, and any blob
    // that was deleted but whose row insert rolled back is an orphan that
    // an ops sweep can reconcile later. We sequence the storage delete
    // AFTER the tx commits so the DB is the source of truth: a rolled-back
    // tx leaves the blob on disk, reachable via the kept attachment row.
    const atts = await db('attachments')
      .whereIn('message_id', batchIds)
      .select('id', 'storage_path');
    await db.transaction(async (trx) => {
      if (atts.length > 0) {
        await trx('attachments')
          .whereIn(
            'id',
            atts.map((a) => a.id as string),
          )
          .del();
      }
      // Bulk crypto-shred. Setting ciphertext to empty bytes in one UPDATE
      // per batch is an order of magnitude faster than the per-row loop.
      await trx('messages')
        .whereIn('id', batchIds)
        .update({ ciphertext: Buffer.alloc(0), ciphertext_meta: {} });
    });
    // Post-commit: free the blob storage. Parallelised — object-store latency
    // dominates. Failures are logged as warnings; orphan blobs are harmless
    // (the row is already gone) and a future sweep can catch them.
    await Promise.all(
      atts.map(async (a) => {
        try {
          await store.delete(a.storage_path as string);
        } catch (err) {
          logger.warn('retention.attachment_delete_failed', {
            attachmentId: a.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    attachmentsDeleted += atts.length;
    messagesShredded += batch.length;
    if (iter === MAX_ITERATIONS - 1 && batch.length === BATCH_SIZE) {
      stoppedAtCapWithFullBatch = true;
    }
  }

  if (stoppedAtCapWithFullBatch) {
    logger.warn('retention.max_iterations_hit', {
      messagesShredded,
      attachmentsDeleted,
      cutoff: cutoff.toISOString(),
      note: 'Backlog not fully drained; next tick will continue.',
    });
  }

  if (messagesShredded === 0) {
    return { retentionDays, messagesShredded: 0, attachmentsDeleted: 0 };
  }

  // Only include `hitCap` in the happy-path log when it's meaningful. Happy
  // path is the common case — keeping the field out saves log noise.
  const logFields: Record<string, unknown> = {
    retentionDays,
    messagesShredded,
    attachmentsDeleted,
    cutoff: cutoff.toISOString(),
  };
  if (stoppedAtCapWithFullBatch) logFields.hitCap = true;
  logger.info('retention.sweep_done', logFields);

  return { retentionDays, messagesShredded, attachmentsDeleted };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start a daily sweep. First run happens SWEEP_DELAY_MS after startup so the
 * appliance doesn't shred on boot; subsequent runs every 24h.
 */
const SWEEP_DELAY_MS = 10 * 60 * 1000; // 10 minutes after boot
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startRetentionTicker(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      await runRetentionSweep();
    } catch (err) {
      logger.error('retention.sweep_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
  timer = setInterval(
    () => {
      void tick();
    },
    SWEEP_INTERVAL_MS,
  );
  // Lazy first run. Unref so the timer never blocks process shutdown in tests.
  if (timer.unref) timer.unref();
  setTimeout(() => {
    void tick();
  }, SWEEP_DELAY_MS).unref?.();
}

export function stopRetentionTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
