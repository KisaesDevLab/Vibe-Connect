/**
 * Phase 27: preserve pre-edit ciphertext for admin review.
 *
 * Before this migration, `messagesRepo.edit()` overwrote `messages.ciphertext`
 * in place — the original was unrecoverable. The product calls for staff to
 * be able to edit a sent message AND for admins to view the prior versions
 * for compliance / dispute investigations. We snapshot the live row into
 * this table inside the same transaction as each edit.
 *
 * `content_key_version` is preserved per snapshot. A conversation key
 * rotation between edits would otherwise leave the history rows encrypted
 * under an older content-key version with no way to look up the matching
 * wrapped key. The admin client still picks up the right wrapped key from
 * `conversation_keys` because we record the version on each row.
 *
 * `replaced_by_user_id` is the staffer who saved the new version. It can
 * differ from the message's `sender_id` only via the (currently impossible)
 * route where a non-sender edits — left as ON DELETE SET NULL because the
 * user record is the editor's identity, not a load-bearing fk for retrieval.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('message_edits', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('message_id').notNullable().references('id').inTable('messages').onDelete('CASCADE');
    t.binary('ciphertext').notNullable();
    t.jsonb('ciphertext_meta').notNullable().defaultTo('{}');
    t.integer('content_key_version').notNullable();
    t.timestamp('replaced_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('replaced_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
  await knex.raw(
    `CREATE INDEX idx_message_edits_message ON message_edits (message_id, replaced_at DESC)`,
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('message_edits');
};
