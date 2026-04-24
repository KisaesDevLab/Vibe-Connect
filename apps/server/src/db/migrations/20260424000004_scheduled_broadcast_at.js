/**
 * Scheduled-message broadcast tracking.
 *
 * The scheduled-message ticker emits `message:new` once a message's
 * `scheduled_for` time elapses so connected clients refetch the conversation.
 * The pre-fix tick selected every row whose `scheduled_for` fell in
 * `[NOW()-1m, NOW()]` and re-broadcast each pass — at the 15-second tick
 * cadence that meant up to four duplicate notifications per scheduled
 * message.
 *
 * `scheduled_broadcast_at` is the once-only marker. The ticker now skips any
 * row whose marker is already set, and stamps the marker at broadcast time so
 * the next tick excludes it. NULL means "never broadcast"; non-NULL means
 * "already announced, do not re-fire". The column also gives ops a way to
 * grep for the actual fan-out time vs. the intended `scheduled_for`.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.timestamp('scheduled_broadcast_at', { useTz: true }).nullable();
  });
  // Backfill: every existing scheduled-and-elapsed message gets stamped so the
  // first post-deploy tick doesn't suddenly re-fire historic broadcasts.
  await knex.raw(
    `UPDATE messages
     SET scheduled_broadcast_at = COALESCE(scheduled_for, created_at)
     WHERE scheduled_for IS NOT NULL
       AND scheduled_for <= NOW()
       AND scheduled_broadcast_at IS NULL`,
  );
  // Partial index: only the still-pending rows. Once a row's broadcast marker
  // is set it falls out of the index, keeping it small even on a big history.
  await knex.raw(
    `CREATE INDEX idx_messages_scheduled_pending
     ON messages (scheduled_for)
     WHERE scheduled_for IS NOT NULL
       AND scheduled_broadcast_at IS NULL
       AND deleted_at IS NULL`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_messages_scheduled_pending`);
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('scheduled_broadcast_at');
  });
};
