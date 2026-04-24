/**
 * Add a deactivated_at timestamp to external_identities so admins can block a
 * client's portal access without deleting the row (keeps conversation membership
 * and audit trail intact).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('external_identities', (t) => {
    t.timestamp('deactivated_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `CREATE INDEX idx_external_identities_active ON external_identities (deactivated_at) WHERE deactivated_at IS NULL`,
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_external_identities_active');
  await knex.schema.alterTable('external_identities', (t) => {
    t.dropColumn('deactivated_at');
  });
};
