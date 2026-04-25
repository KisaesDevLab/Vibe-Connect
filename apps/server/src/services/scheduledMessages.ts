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
import { auditRepo } from '../repositories/audit.js';
import { notifyExternalRecipients } from './offlineNotify.js';

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
 * Phase 24.7: returns a reason string when a request nudge should be skipped
 * at fire time, or null when the nudge is still relevant. The two skip
 * cases — "list isn't active anymore" and "list has nothing pending" —
 * mean the client doesn't need a reminder; ringing them anyway looks
 * sloppy and trains them to ignore real reminders. We re-check the list
 * AT FIRE TIME (not enqueue time) so a list that completes between the
 * scheduling moment and the broadcast window still drops the nudge.
 */
async function shouldSkipNudge(listId: string): Promise<string | null> {
  // Phase 24 kill switch — refuse to broadcast queued nudges when the
  // firm-wide toggle is off. Audit row preserved as `request.nudge_skipped`
  // with reason `requests_disabled`.
  const firmSettings = await db('firm_settings').where({ id: 1 }).first('requests_enabled');
  if (firmSettings && firmSettings.requests_enabled === false) return 'requests_disabled';
  const list = await db('request_lists').where({ id: listId }).first('status');
  if (!list) return 'list_not_found';
  if ((list.status as string) !== 'active') return `list_${list.status as string}`;
  const counts = await db('request_items')
    .where({ list_id: listId })
    .whereIn('status', ['pending', 'revision'])
    .count<{ count: string }[]>('* as count')
    .first();
  if (!counts || Number(counts.count) === 0) return 'no_pending_items';
  return null;
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
    rows: {
      id: string;
      conversation_id: string;
      sender_id: string | null;
      ciphertext_meta: Record<string, unknown> | null;
    }[];
  }>(
    `UPDATE messages
     SET scheduled_broadcast_at = NOW()
     WHERE scheduled_for IS NOT NULL
       AND scheduled_for <= NOW()
       AND scheduled_broadcast_at IS NULL
       AND deleted_at IS NULL
     RETURNING id, conversation_id, sender_id, ciphertext_meta`,
  );
  const rows = result.rows ?? [];
  const failed: string[] = [];
  for (const r of rows) {
    // Phase 24.7: skip + soft-delete request nudges whose target list no
    // longer needs them (already completed, or all items resolved). The
    // broadcaster otherwise dispatches a stale "you have items pending"
    // ping after staff just finished closing the list — annoying for the
    // client, useless for the firm.
    const meta = r.ciphertext_meta ?? {};
    const systemEventType = (meta as { systemEventType?: unknown }).systemEventType;
    const requestListId = (meta as { requestListId?: unknown }).requestListId;
    if (
      systemEventType === 'request_nudge_sent' &&
      typeof requestListId === 'string'
    ) {
      const skip = await shouldSkipNudge(requestListId);
      if (skip !== null) {
        await db('messages').where({ id: r.id }).update({ deleted_at: db.fn.now() });
        await auditRepo.write({
          actorUserId: r.sender_id,
          action: 'request.nudge_skipped',
          targetType: 'request_list',
          targetId: requestListId,
          details: { messageId: r.id, conversationId: r.conversation_id, reason: skip },
        });
        continue;
      }
    }
    if (!broadcaster) continue;
    try {
      await broadcaster.broadcastMessageVisible({ id: r.id, conversationId: r.conversation_id });
      if (systemEventType === 'request_nudge_sent' && typeof requestListId === 'string') {
        await auditRepo.write({
          actorUserId: r.sender_id,
          action: 'request.nudge_sent',
          targetType: 'request_list',
          targetId: requestListId,
          details: { messageId: r.id, conversationId: r.conversation_id },
        });
        // Phase 24 follow-up: actually deliver the nudge to the client out-
        // of-band. The Socket.io fanout above only reaches staff; portal
        // sessions don't have a socket connection. Without this call the
        // build plan's "fans out via the configured email + SMS providers"
        // promise was never actually wired for nudges.
        const meta = r.ciphertext_meta ?? {};
        const listTitle =
          typeof (meta as { listTitle?: unknown }).listTitle === 'string'
            ? String((meta as { listTitle?: string }).listTitle)
            : 'pending items';
        const customBody =
          typeof (meta as { customBody?: unknown }).customBody === 'string'
            ? String((meta as { customBody?: string }).customBody)
            : null;
        const shortBody =
          customBody ?? `Reminder: items still needed for ${listTitle}.`;
        void notifyExternalRecipients({
          conversationId: r.conversation_id,
          subject: `Reminder from your firm — ${listTitle}`,
          shortBody,
        }).catch((err) =>
          logger.warn('scheduled.nudge_client_dispatch_failed', {
            messageId: r.id,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }
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
