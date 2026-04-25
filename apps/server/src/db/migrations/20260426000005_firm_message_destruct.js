/**
 * Phase 27: firm-level controls for the message timed-destruct feature.
 *
 *   - `message_destruct_enabled` is a hard kill switch. When false, the send
 *     route refuses any `destructAfterViewSeconds`, the compose dropdown is
 *     hidden in the staff UI, and any messages already armed continue to
 *     fire (the feature being toggled off shouldn't strand armed messages).
 *
 *   - `message_destruct_max_seconds` caps the dropdown so a staffer can't
 *     pick "destruct in 100 years" by mistake. 7 days (604800s) covers
 *     legitimate workflows (an audit reminder that should evaporate after
 *     the week) without making the feature look like indefinite delayed
 *     deletion.
 *
 * Default ON to match the rest of Vibe Connect's "secure-by-default" stance —
 * a firm that doesn't want it can flip the toggle in admin settings.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('message_destruct_enabled').notNullable().defaultTo(true);
    t.integer('message_destruct_max_seconds').notNullable().defaultTo(604800);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('message_destruct_max_seconds');
    t.dropColumn('message_destruct_enabled');
  });
};
