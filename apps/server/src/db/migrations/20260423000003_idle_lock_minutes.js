/**
 * Per-firm configurable idle-lock timeout (minutes). The staff PWA clears the
 * in-memory device secret after this many minutes of no input, requiring the
 * passphrase to resume. 0 = never auto-lock (user must click the 🔒 button).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.integer('idle_lock_minutes').notNullable().defaultTo(15);
  });
  // Range check so bad inputs can't slip through via direct SQL. 1440 min = 24 h.
  await knex.raw(
    `ALTER TABLE firm_settings ADD CONSTRAINT chk_idle_lock_range CHECK (idle_lock_minutes >= 0 AND idle_lock_minutes <= 1440)`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE firm_settings DROP CONSTRAINT IF EXISTS chk_idle_lock_range`);
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('idle_lock_minutes');
  });
};
