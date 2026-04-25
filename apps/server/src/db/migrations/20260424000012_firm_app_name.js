/**
 * Add an admin-settable display name override for the staff-app chrome
 * (header label + browser tab title). Null/empty falls back to "Vibe Connect"
 * client-side so existing installs keep their current behaviour.
 *
 * Distinct from `firm_name` — that one names the firm in invite emails and
 * portal copy ("from Crouch Farley CPAs"). `app_name` brands the chrome
 * itself, useful for white-labeled deployments where the firm doesn't want
 * "Vibe Connect" surfaced to staff.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.string('app_name', 80).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('app_name');
  });
};
