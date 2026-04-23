/**
 * Scheduled-message ticker.
 *
 * CRYPTO-NOTE: the message row already holds ciphertext + scheduled_for; the `messagesRepo.list`
 * query filters out unscheduled rows by `scheduled_for <= NOW()`. All the ticker has to do is
 * emit a real-time event once a row "becomes visible" so connected clients re-fetch.
 * The socket.io wiring lands in Phase 5 — for Phase 4 we expose an interface so callers can
 * plug in a broadcaster.
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

/** One tick: surface messages whose scheduled_for just elapsed and haven't been surfaced yet. */
export async function runOnce(): Promise<number> {
  const rows = await db('messages')
    .where('scheduled_for', '>', db.raw(`NOW() - INTERVAL '1 minute'`))
    .andWhere('scheduled_for', '<=', db.fn.now())
    .whereNull('deleted_at')
    .select('id', 'conversation_id');
  for (const r of rows) {
    if (broadcaster) {
      await broadcaster.broadcastMessageVisible({ id: r.id, conversationId: r.conversation_id });
    }
  }
  return rows.length;
}
