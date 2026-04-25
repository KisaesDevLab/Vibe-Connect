/**
 * Phase 27: optional per-message timed self-destruct.
 *
 * Two columns:
 *
 *   - `destruct_after_view_seconds` is set by the sender at compose time
 *     (firm-capped, see 20260426000005). NULL means "never".
 *
 *   - `destruct_at` is stamped by the read-receipt handler when the FIRST
 *     non-sender recipient marks the message read. Idempotent: stays NULL
 *     until that first read, then never moves. The destruct ticker
 *     (services/destructMessages.ts) atomically claims rows where
 *     `destruct_at <= NOW() AND deleted_at IS NULL` and soft-deletes them.
 *
 * Soft-delete (NOT crypto-shred) at fire time. Ciphertext stays on the row
 * so an admin can still pull the original via the existing emergency
 * decrypt path — same shape as a manual delete. Crypto-shred for the row
 * happens later via the existing retention service if the firm's
 * conversation retention is short enough to claim it.
 *
 * The partial index on `destruct_at` is the ticker hot path: it scans
 * O(due-now) rows per tick instead of the full messages table.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.integer('destruct_after_view_seconds').nullable();
    t.timestamp('destruct_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `CREATE INDEX idx_messages_destruct_due ON messages (destruct_at)
     WHERE destruct_at IS NOT NULL AND deleted_at IS NULL`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_messages_destruct_due`);
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('destruct_at');
    t.dropColumn('destruct_after_view_seconds');
  });
};
