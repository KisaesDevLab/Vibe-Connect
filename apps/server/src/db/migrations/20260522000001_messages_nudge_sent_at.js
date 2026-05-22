/**
 * v0.4.33 — out-of-band nudge for unread client messages.
 *
 * When staff sends a message to a conversation with external_identity
 * (portal-client) members, those clients only see the message when
 * they next open the portal. They might miss it entirely until their
 * next visit. This column powers a 15-minute follow-up: a ticker
 * (services/clientMessageNudgeTicker.ts) finds messages that:
 *   - were sent by staff (sender_user_id IS NOT NULL)
 *   - are at least 15 minutes old
 *   - have not been read by every external recipient
 *   - have not yet been nudged (`nudge_sent_at IS NULL`)
 * and dispatches an email + SMS to those recipients via the existing
 * notifyExternalRecipients fanout. The body is metadata-only
 * ("you have a new message — open the portal") per CLAUDE.md's
 * notification rules — message content never rides the SMS/email.
 *
 * `nudge_sent_at` is stamped by the ticker's atomic UPDATE ...
 * RETURNING claim so two ticker instances can't double-nudge the
 * same message. Once stamped, the ticker skips the row even if some
 * recipients later go unread again — the user spec is "one nudge per
 * message", not "nudge until every recipient reads".
 *
 * The partial index makes the ticker's hot query (find messages with
 * NULL nudge_sent_at older than 15 min) a small index range scan
 * regardless of total messages-table size.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.timestamp('nudge_sent_at', { useTz: true }).nullable();
  });
  // CRITICAL BACKFILL: every pre-existing message is older than the
  // 15-minute threshold AND has NULL nudge_sent_at. Without this
  // backfill, the first ticker tick after deploy would claim
  // EVERY historical staff-sent message and try to dispatch a
  // notification per row — flooding Postmark / Emailit / Twilio
  // with thousands of "you have a new secure message" pings for
  // messages from days or months ago.
  //
  // Stamp every existing row to NOW() so they look "already
  // nudged". The ticker's hot query becomes a small partial-index
  // scan that picks up only messages created from this point
  // forward — the intended behavior.
  await knex.raw(`UPDATE messages SET nudge_sent_at = NOW() WHERE nudge_sent_at IS NULL`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS messages_nudge_pending_idx
      ON messages (created_at)
      WHERE nudge_sent_at IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS messages_nudge_pending_idx');
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('nudge_sent_at');
  });
};
