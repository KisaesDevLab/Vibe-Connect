// Phase 24.7 — auto-nudge sweeper.
//
// Once an hour: walk every active request_list with a due_date, expand
// firm_settings.auto_nudge_offsets_hours into target send-times, and
// enqueue a nudge for any target falling inside the upcoming hour. The
// existing scheduled-message ticker (services/scheduledMessages.ts)
// handles delivery at fire time. We don't broadcast directly here — that
// keeps a single place where "nudge delivery" actually happens, which
// matters for the skip-on-completion check + the rate limit.
//
// Idempotency: enqueueAutoNudgeIfMissing() checks for a prior nudge
// keyed on (requestListId, autoOffsetHours) before inserting, so a
// process restart inside the target hour can't double-enqueue.
//
// Default OFF: firm_settings.auto_nudge_enabled defaults to false (see
// migration 20260425000002_firm_auto_nudge.js). An admin opts in via
// Admin → Settings.
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { enqueueAutoNudgeIfMissing } from './requestsService.js';

let timer: NodeJS.Timeout | null = null;

/**
 * Floors `now` to the start of the current hour in UTC. The auto sweeper
 * fires nudges that should land "in the next hour" so all targets land
 * on hour boundaries, simplifying the idempotency key (one nudge per
 * (list, offset) combination per appliance lifetime).
 */
function startOfHour(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

interface ActiveListRow {
  id: string;
  conversation_id: string;
  due_date: string | Date;
}

export async function runAutoNudgeOnce(now: Date = new Date()): Promise<number> {
  // Pull the firm config first; bail without a query if disabled, so the
  // hot path in production (auto-nudge OFF) is one row read per hour.
  const settings = await db('firm_settings').where({ id: 1 }).first(
    'auto_nudge_enabled',
    'auto_nudge_offsets_hours',
    'requests_enabled',
  );
  if (!settings || !settings.auto_nudge_enabled) return 0;
  // Phase 24 kill switch: when an admin disables Requests firm-wide, the
  // auto-nudge sweeper stops queueing reminders. Existing queued nudges
  // drain through the ticker which honours the same flag.
  if (settings.requests_enabled === false) return 0;
  const offsets = (settings.auto_nudge_offsets_hours as number[] | null) ?? [];
  if (offsets.length === 0) return 0;

  const hourStart = startOfHour(now);
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

  // Pull every active list with a due date. Range at the appliance scale
  // is small (low hundreds of lists max) so we don't bother filtering at
  // the SQL layer beyond `status='active'` + `due_date NOT NULL`.
  const rows = (await db('request_lists')
    .where({ status: 'active' })
    .whereNotNull('due_date')
    .select('id', 'conversation_id', 'due_date')) as ActiveListRow[];

  let enqueued = 0;
  for (const r of rows) {
    const dueAtUtc = parseDueDate(r.due_date);
    if (!dueAtUtc) continue;
    for (const off of offsets) {
      const target = new Date(dueAtUtc.getTime() - off * 60 * 60 * 1000);
      // Pin to the hour boundary so the idempotency key stays clean and
      // a restart mid-hour can't enqueue at a slightly later minute.
      const targetHour = startOfHour(target);
      if (targetHour.getTime() !== hourStart.getTime()) continue;
      // Send-at intentionally equals the hour boundary — the schedule
      // ticker fires within ~15s of that timestamp.
      try {
        const out = await enqueueAutoNudgeIfMissing({
          listId: r.id,
          conversationId: r.conversation_id,
          // Fire at the END of the current sweeper hour so the next 15s
          // scheduledMessages tick definitely picks it up before staff has
          // reason to think the nudge "didn't go out."
          scheduledForIso: hourEnd.toISOString(),
          offsetHours: off,
        });
        if (out) enqueued++;
      } catch (err) {
        logger.warn('auto_nudge_enqueue_failed', {
          listId: r.id,
          offsetHours: off,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return enqueued;
}

/**
 * Postgres `date` columns deserialise as Date|string depending on the
 * driver — match the same defensive parsing the request presenters use.
 * Returns midnight UTC of the due date so all offset arithmetic uses a
 * stable anchor.
 */
function parseDueDate(value: string | Date): Date | null {
  if (value instanceof Date) {
    const d = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    return d;
  }
  // String form: "YYYY-MM-DD" — anchor to UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const yyyy = Number(value.slice(0, 4));
    const mm = Number(value.slice(5, 7));
    const dd = Number(value.slice(8, 10));
    return new Date(Date.UTC(yyyy, mm - 1, dd));
  }
  return null;
}

export function startAutoNudgeJob(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  // Fire once immediately on startup so an appliance restart that lands
  // mid-hour doesn't permanently miss the offsets that should have been
  // enqueued earlier in the current hour. The idempotency check inside
  // enqueueAutoNudgeIfMissing prevents duplicate enqueues if the previous
  // sweep already covered this hour.
  void runAutoNudgeOnce()
    .then((n) => {
      if (n > 0) logger.info('auto_nudge_enqueued', { count: n, source: 'startup' });
    })
    .catch((err) => logger.error('auto_nudge_run_failed', { err: String(err) }));
  timer = setInterval(() => {
    runAutoNudgeOnce()
      .then((n) => {
        if (n > 0) logger.info('auto_nudge_enqueued', { count: n });
      })
      .catch((err) => logger.error('auto_nudge_run_failed', { err: String(err) }));
  }, intervalMs);
}

export function stopAutoNudgeJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
