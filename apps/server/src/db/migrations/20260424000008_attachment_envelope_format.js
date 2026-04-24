/**
 * Envelope format discriminator on attachments.
 *
 * Two envelope shapes now live in the same columns:
 *   - 'conversation-key-v1': filename_ciphertext is secretbox(convKey, name),
 *     wrapped_file_key is secretbox(convKey, fileKey). Staff and portal
 *     uploads use this format. Clients decrypt with the conversation key.
 *   - 'bridge-sealed-v1': filename_ciphertext is a firm-key-sealed envelope
 *     (sealPlaintextForBridge), wrapped_file_key is empty bytes. Produced by
 *     the email bridge; unreadable until a staff-side rewrap pass.
 *
 * Without this column, consumers had to infer the format from peripheral
 * signals (empty wrapped_file_key, message.source, ciphertext_meta). A
 * dedicated discriminator makes the rewrap path (future phase) and any
 * recovery tooling unambiguous.
 *
 * Existing rows are backfilled to 'conversation-key-v1' since they were all
 * produced by the staff/portal upload paths before this column existed.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('attachments', (t) => {
    t.string('envelope_format', 32).notNullable().defaultTo('conversation-key-v1');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('attachments', (t) => {
    t.dropColumn('envelope_format');
  });
};
