/**
 * Phase 27: timed-destruct ticker.
 *
 * Mirrors the contract in `services/scheduledMessages.ts`. A message becomes
 * eligible for destruction once the read-receipt handler has stamped
 * `destruct_at = NOW() + destruct_after_view_seconds` on first non-sender
 * read. The ticker:
 *
 *   1. Atomically claims every due row (`destruct_at <= NOW() AND deleted_at
 *      IS NULL AND destruct_at IS NOT NULL`) via UPDATE ... RETURNING and
 *      stamps `deleted_at = NOW()` in the same statement. Concurrent ticks
 *      across server instances each see disjoint row sets because the row
 *      lock taken by the UPDATE is exclusive.
 *
 *   2. For each claimed row: writes `message.destructed` audit, touches the
 *      conversation so the sidebar re-orders, and fans out a `message:delete`
 *      socket event so connected clients replace the bubble with the
 *      tombstone placeholder. We re-use `message:delete` rather than
 *      coining `message:destructed` because the recipient-facing UI is
 *      identical; admins distinguish the two via the audit log.
 *
 * CRYPTO-NOTE: this is soft-delete only. Ciphertext stays on the row so an
 * admin can pull the original via /admin/messages/:id/history. Crypto-shred
 * happens later (or not at all) via `services/retention.ts`. This is the
 * deliberate D2 design decision in the Phase 27 plan.
 */
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { conversationsRepo } from '../repositories/conversations.js';

export interface DestructBroadcaster {
  broadcastMessageDestructed: (message: {
    id: string;
    conversationId: string;
  }) => Promise<void> | void;
}

let broadcaster: DestructBroadcaster | null = null;
let timer: NodeJS.Timeout | null = null;

export function setDestructBroadcaster(b: DestructBroadcaster): void {
  broadcaster = b;
}

export function startDestructTicker(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error('destruct_tick_failed', { err: String(err) }));
  }, intervalMs);
  // Immediate run for tests and so a recently-armed message doesn't wait a
  // full interval after server start.
  void runOnce();
}

export function stopDestructTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One tick: claim every due destruct row in a single UPDATE ... RETURNING and
 * fan out `message:delete` for each. The atomicity guarantee:
 *
 *   - Two concurrent ticks (or two server instances) both issue this UPDATE.
 *     The row-level lock means each row is returned to exactly one caller, so
 *     the audit log records exactly one `message.destructed` per message and
 *     the realtime fanout fires once.
 *
 *   - A broadcast failure does NOT roll back the soft-delete. The row stays
 *     deleted in the DB; clients will pick up the change on their next list
 *     fetch even if they missed the realtime event. This differs from the
 *     scheduled-message ticker (which DOES un-stamp on broadcast failure)
 *     because there the broadcast IS the visible effect — if it fails, the
 *     message appears not to exist. Here the soft-delete is the visible
 *     effect; the broadcast is just a refresh hint.
 */
export async function runOnce(): Promise<number> {
  const result = await db.raw<{
    rows: { id: string; conversation_id: string; sender_id: string | null }[];
  }>(
    `UPDATE messages
     SET deleted_at = NOW()
     WHERE destruct_at IS NOT NULL
       AND destruct_at <= NOW()
       AND deleted_at IS NULL
     RETURNING id, conversation_id, sender_id`,
  );
  const rows = result.rows ?? [];
  for (const r of rows) {
    try {
      await auditRepo.write({
        actorUserId: r.sender_id,
        action: 'message.destructed',
        targetType: 'message',
        targetId: r.id,
        details: { conversationId: r.conversation_id },
      });
      await conversationsRepo.touchUpdated(r.conversation_id);
      if (broadcaster) {
        await broadcaster.broadcastMessageDestructed({
          id: r.id,
          conversationId: r.conversation_id,
        });
      }
    } catch (err) {
      logger.error('destruct_post_claim_failed', {
        messageId: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows.length;
}
