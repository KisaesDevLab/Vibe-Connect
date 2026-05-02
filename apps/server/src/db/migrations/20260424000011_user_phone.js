/**
 * Adds a phone column to the staff `users` table so the SMS-fallback
 * notification preference has a target to dispatch to. Nullable and
 * deliberately NOT unique — two staff members may legitimately share a
 * household landline, and forcing uniqueness would turn an operational
 * convenience into a support ticket.
 *
 * Storage format is E.164 (normalizePhone() in services/accessCodes.ts).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('phone', 32).nullable();
  });
  await knex.raw(`CREATE INDEX idx_users_phone ON users (phone) WHERE phone IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_users_phone');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('phone');
  });
};
