/**
 * Scheduled-message ticker.
 *
 * CRYPTO-NOTE: the message row already holds ciphertext + scheduled_for; the `messagesRepo.list`
 * query filters out unscheduled rows by `scheduled_for <= NOW()`. The ticker only emits a
 * real-time event once a row "becomes visible" so connected clients re-fetch.
 * The broadcaster is injected by `apps/server/src/index.ts` via `setScheduledBroadcaster`
 * and currently forwards to the Postgres LISTEN/NOTIFY fanout.
 */
import { db } from '../db/knex.js';
import { logger } from '../logger.js';

export interface ScheduledBroadcaster {
  broadcastMessageVisible: (message: {
    id: string;
    conversationId: string;
  }) => Promise<void> | void;
}

let broadcaster: ScheduledBroadcaster | null = null;
let timer: NodeJS.Timeout | null = null;

export function setScheduledBroadcaster(b: ScheduledBroadcaster): void {
  broadcaster = b;
}

export function startScheduledMessageTicker(intervalMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error('scheduled_tick_failed', { err: String(err) }));
  }, intervalMs);
  // Immediately run once so tests don't need to wait.
  void runOnce();
}

export function stopScheduledMessageTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One tick: surface messages whose scheduled_for has elapsed and which haven't
 * been broadcast yet.
 *
 * Atomicity: a single UPDATE ... RETURNING claims every still-pending row by
 * stamping `scheduled_broadcast_at` and returns the rows that the current tick
 * should fan out. Two ticks running in the same instant (or two server
 * instances) both call this UPDATE; the row-level lock means each row is
 * returned to exactly one caller. The previous time-window approach
 * re-broadcast every row up to ~four times per scheduled message because the
 * select had no exclusion of already-announced rows.
 *
 * Broadcast failure handling: if `broadcaster.broadcastMessageVisible` throws
 * (e.g., pg_notify socket drop during reconnect, broadcaster not wired yet),
 * we UN-stamp `scheduled_broadcast_at` on the affected rows so the next tick
 * retries. Without this, a transient failure at broadcast time would stamp
 * the row as "already broadcast" and staff clients would silently miss the
 * message:new event until they navigate to refresh.
 *
 * No backstop window is needed any more — once `scheduled_broadcast_at IS NULL`
 * is the only filter, even a multi-hour ticker outage just produces a single
 * delayed-but-correct broadcast on recovery instead of silently missing rows.
 */
export async function runOnce(): Promise<number> {
  const result = await db.raw<{
    rows: { id: string; conversation_id: string }[];
  }>(
    `UPDATE messages
     SET scheduled_broadcast_at = NOW()
     WHERE scheduled_for IS NOT NULL
       AND scheduled_for <= NOW()
       AND scheduled_broadcast_at IS NULL
       AND deleted_at IS NULL
     RETURNING id, conversation_id`,
  );
  const rows = result.rows ?? [];
  const failed: string[] = [];
  for (const r of rows) {
    if (!broadcaster) continue;
    try {
      await broadcaster.broadcastMessageVisible({ id: r.id, conversationId: r.conversation_id });
    } catch (err) {
      failed.push(r.id);
      logger.error('scheduled_broadcast_failed', {
        messageId: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed.length > 0) {
    // Roll back the stamp so the next tick retries these rows. Best-effort —
    // if this UPDATE also fails the rows stay stamped and we rely on the
    // log above for visibility.
    try {
      await db('messages')
        .whereIn('id', failed)
        .update({ scheduled_broadcast_at: null });
    } catch (err) {
      logger.error('scheduled_broadcast_rollback_failed', {
        count: failed.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows.length - failed.length;
}
