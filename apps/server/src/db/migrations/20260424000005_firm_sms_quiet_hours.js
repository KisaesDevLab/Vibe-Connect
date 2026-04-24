/**
 * Firm-configurable SMS quiet-hours window.
 *
 * TCPA quiet hours (8am–9pm recipient local time) are a hard floor, not a
 * ceiling — some states impose stricter rules and some firms want tighter
 * defaults (e.g. 9am–6pm) matching their own office hours. The pre-fix code
 * baked 8/21 directly into smsBridge.ts, which meant any change required a
 * code deploy. These two columns surface the window in firm_settings so an
 * admin can tune it from the UI.
 *
 * Values are integers 0..23 (hour-of-day in the recipient's own timezone from
 * `external_identities.preferences.timezone`, falling back to UTC). Defaults
 * match the legacy hardcoded behaviour so existing installs don't change.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.integer('sms_quiet_start_hour').notNullable().defaultTo(8);
    t.integer('sms_quiet_end_hour').notNullable().defaultTo(21);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('sms_quiet_end_hour');
    t.dropColumn('sms_quiet_start_hour');
  });
};
