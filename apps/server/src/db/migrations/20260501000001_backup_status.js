/**
 * Backup-status fields on firm_settings for the appliance Duplicati
 * integration. The heartbeat endpoint records `last_backup_ok_at` on
 * every successful backup; the admin key-status endpoint reports the
 * staleness back to the operator. When BACKUP_REQUIRED is on, the
 * server warns + eventually blocks new vault uploads if the heartbeat
 * goes silent for too long — better to fail loud while the firm key
 * is still recoverable than to silently accept uploads that can never
 * be restored.
 *
 * `last_backup_status` is jsonb so the appliance can stash structured
 * detail (rows touched, bytes copied, destination hash). The shape is
 * intentionally not modeled in SQL — different backup tools emit
 * different envelopes.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.timestamp('last_backup_ok_at', { useTz: true }).nullable();
    t.timestamp('last_backup_recorded_at', { useTz: true }).nullable();
    t.jsonb('last_backup_status').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('last_backup_status');
    t.dropColumn('last_backup_recorded_at');
    t.dropColumn('last_backup_ok_at');
  });
};
