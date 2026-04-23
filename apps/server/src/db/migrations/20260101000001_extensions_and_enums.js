/**
 * Vibe Connect — base extensions, enum types, and helper domains.
 * Runs before every table migration. Kept plain-JS per the build plan.
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // Enum types — created once; tables reference them by name.
  await knex.raw(`DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active', 'away', 'dnd', 'offline');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE client_platform AS ENUM ('tauri-win', 'tauri-mac', 'tauri-linux', 'pwa', 'web');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE conversation_type AS ENUM ('internal', 'external', 'internal_thread');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE message_source AS ENUM ('app', 'email-in', 'sms-in', 'system');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE verification_type AS ENUM ('ssn', 'ein', 'none');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE access_code_channel AS ENUM ('email', 'sms');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await knex.raw(`DO $$ BEGIN
    CREATE TYPE sms_provider AS ENUM ('textlink', 'twilio', 'mock');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TYPE IF EXISTS sms_provider`);
  await knex.raw(`DROP TYPE IF EXISTS access_code_channel`);
  await knex.raw(`DROP TYPE IF EXISTS verification_type`);
  await knex.raw(`DROP TYPE IF EXISTS message_source`);
  await knex.raw(`DROP TYPE IF EXISTS conversation_type`);
  await knex.raw(`DROP TYPE IF EXISTS client_platform`);
  await knex.raw(`DROP TYPE IF EXISTS user_status`);
  // pgcrypto left in place; shared by the whole DB.
};
