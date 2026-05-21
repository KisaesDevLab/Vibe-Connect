/**
 * Phase 28 follow-up — add `client_message_enc` to `intake_sessions`.
 *
 * Free-text message the client types on the intake form ("here are my
 * 1099s for Q3, lmk if you need anything else"). Encrypted with the same
 * intake key as name/email/phone (libsodium secretbox, raw bytea). No
 * search-hash sibling — the message is free-form so an attacker who can
 * compute hashes for known plaintexts gets nothing useful out of one.
 *
 * The column is NULLable because:
 *   - The form field is optional (sometimes a client just attaches files).
 *   - Existing sessions from before the migration MUST stay readable;
 *     a NOT NULL default-empty would force a backfill.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('intake_sessions', (t) => {
    t.binary('client_message_enc').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('intake_sessions', (t) => {
    t.dropColumn('client_message_enc');
  });
};
