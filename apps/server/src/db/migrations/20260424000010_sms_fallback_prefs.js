/**
 * Add SMS-fallback preference flags to notification_prefs, mirroring the
 * existing email_fallback_* columns.
 *
 * Off by default because a staff row may have no phone on file yet — an
 * opt-in flip here should be a deliberate action once the user has set
 * their mobile number. `sms_fallback_urgent_only` keeps the same 0/1
 * integer shape as its email sibling for consistency with the existing
 * PATCH handler.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.boolean('sms_fallback_enabled').notNullable().defaultTo(false);
    t.integer('sms_fallback_urgent_only').notNullable().defaultTo(1);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.dropColumn('sms_fallback_urgent_only');
    t.dropColumn('sms_fallback_enabled');
  });
};
