/**
 * Firm-wide mutable settings. Singleton row.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('firm_settings', (t) => {
    t.integer('id').primary().defaultTo(1);
    t.string('firm_name', 255).notNullable().defaultTo('Your Firm');
    t.string('logo_url', 1024).nullable();
    t.integer('retention_days').nullable(); // null = infinite
    t.integer('stepup_timeout_hours').notNullable().defaultTo(24); // 4|8|24|168|-1
    t.string('email_outbound_mode', 16).notNullable().defaultTo('summary'); // summary|content
    t.integer('email_outbound_content_preview_chars').notNullable().defaultTo(200);
    t.specificType('sms_provider', 'sms_provider').notNullable().defaultTo('mock');
    t.integer('sms_monthly_cap').notNullable().defaultTo(1000);
    t.boolean('export_external_requires_recovery_phrase').notNullable().defaultTo(true);
    t.jsonb('sidebar_groups_order').notNullable().defaultTo('[]');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE firm_settings ADD CONSTRAINT chk_singleton CHECK (id = 1)`);
  await knex.raw(`INSERT INTO firm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('firm_settings');
};
