/**
 * Firm-configurable message edit window.
 *
 * Previously EDIT_WINDOW_MS was a 15-minute constant baked into the route.
 * Different firms have different compliance stances — some want no edits at
 * all post-send (audit trail), some want a long grace period (correcting
 * typos in a client-facing thread). This column surfaces the value to the
 * admin UI so it doesn't require a code change.
 *
 * Value is minutes. 0 = edits disabled entirely (send-only). Default 15
 * preserves the pre-migration behaviour.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.integer('message_edit_window_minutes').notNullable().defaultTo(15);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('message_edit_window_minutes');
  });
};
