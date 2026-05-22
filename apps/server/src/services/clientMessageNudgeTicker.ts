/**
 * v0.4.33 — 15-minute unread-message nudge for portal clients.
 *
 * When staff sends a message into a conversation that has external-
 * identity (portal-client) members, those clients only see the
 * message when they next open the portal. If they don't open the
 * portal within 15 minutes, this ticker emails / SMSes them a
 * metadata-only "you have a new message" notification via the
 * existing notifyExternalRecipients fanout — same fallback channels
 * the request-nudge and scheduled-broadcast paths already use.
 *
 * CRYPTO: payload is metadata-only by construction. The ticker holds
 * no conversation key, calls into notifyExternalRecipients with a
 * generic "open the portal" body, and never reads the ciphertext
 * column. Per CLAUDE.md's notification rules — message content never
 * rides the SMS/email fallback.
 *
 * Mechanics:
 *   1. Every NUDGE_INTERVAL_MS (default 60s), claim messages where:
 *        - created_at <= NOW() - 15 minutes
 *        - nudge_sent_at IS NULL          (one nudge per message ever)
 *        - sender_id IS NOT NULL          (staff-originated only;
 *          sender_id is the FK to `users`, distinct from
 *          sender_external_identity_id which marks portal-originated)
 *        - source = 'app'                  (not bridged-in)
 *        - deleted_at IS NULL              (skip tombstoned)
 *        - scheduled_for IS NULL OR scheduled_broadcast_at IS NOT NULL
 *          (already delivered to live sockets)
 *      via an atomic UPDATE ... RETURNING that stamps nudge_sent_at
 *      in the same statement — two ticker instances can't double-
 *      claim the same row.
 *   2. For each claimed row, call notifyExternalRecipients with
 *      `excludeReadOfMessageId` set so clients who already read the
 *      message in the 15-min window get skipped (the
 *      offlineNotify-side filter strips them by read_receipts join).
 *
 * Failure handling:
 *   - notifyExternalRecipients itself never throws; per-recipient
 *     channel errors are logged + reflected in its return value.
 *   - If the claim UPDATE fails, the whole tick is skipped and the
 *     next tick retries. Rows stay nudge_sent_at=NULL.
 *   - If dispatch fails AFTER claim, the row's nudge_sent_at is
 *     already stamped — we accept "best-effort, one shot" semantics
 *     rather than UN-stamping on failure (which could re-fire the
 *     same nudge minutes apart if a provider blip recovers slowly).
 *
 * Wiring: apps/server/src/index.ts boots the ticker via
 * startClientMessageNudgeTicker() alongside the existing
 * scheduled-message ticker; shutdown calls
 * stopClientMessageNudgeTicker() in the cleanup chain.
 */
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { notifyExternalRecipients } from './offlineNotify.js';

const DEFAULT_INTERVAL_MS = 60_000;
const NUDGE_THRESHOLD_MINUTES = 15;
// Per-tick cap on how many messages get claimed (and dispatched) in a
// single iteration. Defense in depth: the migration backfills
// nudge_sent_at on every pre-existing row so the steady-state pending
// pool is small, but if anything ever produces a pile-up (operator
// disabled the ticker for a few hours, a multi-instance scheduled-
// broadcast pushed N messages into the eligible window at once,
// retroactive schema changes), this caps the parallel-fanout blast
// radius. Excess rows are picked up on the next tick(s) without
// dropping any.
const PER_TICK_CAP = 200;

let timer: NodeJS.Timeout | null = null;

export function startClientMessageNudgeTicker(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) =>
      logger.error('client_nudge_tick_failed', {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }, intervalMs);
  // Run once at startup so tests don't have to wait the full interval
  // and so a freshly-booted server processes any in-flight nudge
  // candidates immediately instead of holding them until the next
  // interval tick.
  void runOnce();
}

export function stopClientMessageNudgeTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One tick: claim every eligible message, dispatch a metadata-only
 * fanout per claimed row, return the count claimed. Exported for
 * test-level "advance time and call runOnce()" assertions.
 */
export async function runOnce(): Promise<number> {
  const result = await db.raw<{
    rows: { id: string; conversation_id: string }[];
  }>(
    // Subquery-claim pattern lets us cap how many rows a single tick
    // takes. Plain `UPDATE ... LIMIT` isn't standard Postgres — we
    // pick the row set first, then UPDATE the chosen ids. The CAP
    // is intentionally generous (200 messages × ≤2 channels = 400
    // provider calls/min worst case, well under Postmark's 10 req/s
    // default) but bounded so a pile-up can't translate into a
    // single-tick fanout flood.
    `UPDATE messages
       SET nudge_sent_at = NOW()
     WHERE id IN (
       SELECT id FROM messages
       WHERE nudge_sent_at IS NULL
         AND sender_id IS NOT NULL
         AND source = 'app'
         AND deleted_at IS NULL
         AND created_at <= NOW() - INTERVAL '${NUDGE_THRESHOLD_MINUTES} minutes'
         AND (scheduled_for IS NULL OR scheduled_broadcast_at IS NOT NULL)
       ORDER BY created_at ASC
       LIMIT ${PER_TICK_CAP}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, conversation_id`,
  );
  const rows = result.rows ?? [];
  if (rows.length === 0) return 0;

  // Honors firm-wide client-messaging kill switch. If messaging is
  // off, claiming the rows already stamped nudge_sent_at (so they
  // won't be re-attempted on next tick) but skip the actual dispatch
  // — same pattern the request-nudge path uses on its kill switch.
  const firmRow = await db('firm_settings').where({ id: 1 }).first('client_messaging_enabled');
  const messagingEnabled = Boolean(firmRow?.client_messaging_enabled ?? true);
  if (!messagingEnabled) {
    logger.info('client_nudge.skipped_messaging_disabled', { count: rows.length });
    return rows.length;
  }

  for (const r of rows) {
    void notifyExternalRecipients({
      conversationId: r.conversation_id,
      subject: 'New message from your firm',
      shortBody: "You've got a new secure message waiting in your client portal.",
      excludeReadOfMessageId: r.id,
    }).catch((err) =>
      logger.warn('client_nudge.dispatch_failed', {
        messageId: r.id,
        conversationId: r.conversation_id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return rows.length;
}
