/**
 * Lets admins pick the outbound email provider from the UI instead of the
 * EMAIL_PROVIDER env var. Mirrors the existing sms_provider column but with
 * a dedicated enum because the valid values differ ('mock' | 'postmark' |
 * 'postfix'). Default 'mock' so a fresh appliance doesn't accidentally send
 * real email until an admin explicitly picks a provider + configures its
 * credentials in Admin → Providers.
 */
exports.up = async function up(knex) {
  await knex.raw(`DO $$ BEGIN
    CREATE TYPE email_provider AS ENUM ('mock', 'postmark', 'postfix');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await knex.schema.alterTable('firm_settings', (t) => {
    t.specificType('email_provider', 'email_provider').notNullable().defaultTo('mock');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('email_provider');
  });
  await knex.raw(`DROP TYPE IF EXISTS email_provider`);
};
