/**
 * Phase 24: auto-nudge configuration on the singleton firm_settings row.
 *
 * Default OFF — opt-in per firm so existing installs don't start texting
 * clients on a schedule the moment this lands. `auto_nudge_offsets_hours`
 * is the list of "hours before due_date" at which the auto-nudge job will
 * enqueue a reminder; defaults match the original Phase 24 plan
 * (72h, 24h, day-of). Stored as an integer array so an admin can drop
 * 72h or add 168h without a schema change.
 *
 * Manual nudges (POST /request-lists/:id/nudge) work regardless of this
 * flag — the toggle only governs the autoNudge.ts hourly sweeper.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('auto_nudge_enabled').notNullable().defaultTo(false);
    t.specificType('auto_nudge_offsets_hours', 'integer[]')
      .notNullable()
      .defaultTo(knex.raw('ARRAY[72, 24, 0]::integer[]'));
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('auto_nudge_offsets_hours');
    t.dropColumn('auto_nudge_enabled');
  });
};
