/**
 * Phase 28.12 (QA-followup) — per-staff intake notification preference.
 *
 * Adds `users.intake_notify_mode` enum-as-text with three values:
 *   'realtime'    — current default; ticker sends email + in_app per finalize.
 *   'digest'      — ticker defers email rows to the next firm-local digest
 *                   hour, then aggregates into one summary email. in_app
 *                   stays realtime regardless of this setting.
 *   'in_app_only' — ticker skips email rows entirely (marks them 'sent'
 *                   with a no-op reason in last_error). in_app realtime.
 *
 * The 28.5 finalize enqueue path is UNCHANGED — it still inserts an email
 * row per staff member regardless of preference. The preference is read
 * by `intakeStaffNotifyTicker.processOne` so that per-row routing logic
 * stays centralized.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.text('intake_notify_mode').notNullable().defaultTo('realtime');
  });
  await knex.raw(
    `ALTER TABLE users ADD CONSTRAINT chk_users_intake_notify_mode
       CHECK (intake_notify_mode IN ('realtime', 'digest', 'in_app_only'))`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_intake_notify_mode`);
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('intake_notify_mode');
  });
};
