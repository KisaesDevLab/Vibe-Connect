/**
 * Phase 26 — Client Vault firm-level settings.
 *
 * All vault knobs land on the singleton firm_settings row, matching the
 * pattern Phase 24 (auto_nudge) used. Defaults favour safe states:
 *
 *   vault_enabled                true   visible-on-upgrade kill-switch
 *   vault_client_delete          true   clients can soft-delete their own uploads
 *   vault_max_file_bytes      262144000 250 MB (vs 100 MB for messages)
 *   vault_retention_shared_days  0      0 = no auto-expiry
 *   vault_retention_staff_days   0
 *   vault_folder_templates      [...]   default tax-firm template; seed populates
 *   vault_new_year_cron_enabled  false  auto-instantiate new-year folders
 *   vault_information_barrier    false  if true, staff need explicit per-client grant
 *
 * `vault_folder_templates` is JSONB so an admin can edit without a schema
 * change. Each entry: {nameTemplate, zone, retentionDays?}. The `{YYYY}`
 * placeholder is substituted at apply-time.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('vault_enabled').notNullable().defaultTo(true);
    t.boolean('vault_client_delete').notNullable().defaultTo(true);
    t.bigInteger('vault_max_file_bytes').notNullable().defaultTo(262144000);
    t.integer('vault_retention_shared_days').notNullable().defaultTo(0);
    t.integer('vault_retention_staff_days').notNullable().defaultTo(0);
    t.jsonb('vault_folder_templates').notNullable().defaultTo('[]');
    t.boolean('vault_new_year_cron_enabled').notNullable().defaultTo(false);
    t.boolean('vault_information_barrier').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('vault_information_barrier');
    t.dropColumn('vault_new_year_cron_enabled');
    t.dropColumn('vault_folder_templates');
    t.dropColumn('vault_retention_staff_days');
    t.dropColumn('vault_retention_shared_days');
    t.dropColumn('vault_max_file_bytes');
    t.dropColumn('vault_client_delete');
    t.dropColumn('vault_enabled');
  });
};
