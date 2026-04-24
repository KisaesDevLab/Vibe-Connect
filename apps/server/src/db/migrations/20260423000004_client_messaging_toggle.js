/**
 * Firm-wide kill switch for all client-facing messaging. When disabled:
 *   - Portal /identify silently drops (no access code sent, indistinguishable from
 *     an unknown identifier so deactivation isn't leaked).
 *   - Portal /verify refuses.
 *   - Inbound email / SMS bridge messages are dropped (with audit row).
 *   - Staff cannot create new external conversations.
 *
 * Internal staff-to-staff messaging is unaffected.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('client_messaging_enabled').notNullable().defaultTo(true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('client_messaging_enabled');
  });
};
