/**
 * External client identities, access codes, client sessions, SMS opt-ins.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('external_identities', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('email', 255).notNullable();
    t.string('phone', 32).nullable();
    t.string('display_name', 128).notNullable();
    t.string('firm_client_ref', 128).nullable();
    t.specificType('verification_type', 'verification_type').notNullable().defaultTo('none');
    t.string('verification_last4_hash', 255).nullable(); // bcrypt of last-4 of SSN/EIN
    t.boolean('verification_required').notNullable().defaultTo(true);
    t.jsonb('preferences').notNullable().defaultTo('{}');
    t.timestamp('first_invited_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_active_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['email']);
  });
  await knex.raw(
    `CREATE INDEX idx_external_identities_phone ON external_identities (phone) WHERE phone IS NOT NULL`,
  );

  await knex.schema.createTable('access_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('external_identity_id')
      .notNullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    t.string('code_hash', 255).notNullable(); // bcrypt
    t.string('sent_to', 255).notNullable(); // the email or phone we sent it to
    t.specificType('sent_via', 'access_code_channel').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `CREATE INDEX idx_access_codes_identity ON access_codes (external_identity_id, created_at DESC)`,
  );
  await knex.raw(`CREATE INDEX idx_access_codes_expires ON access_codes (expires_at)`);

  await knex.schema.createTable('client_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('external_identity_id')
      .notNullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    t.string('session_token_hash', 255).notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('absolute_expires_at', { useTz: true }).notNullable();
    t.timestamp('verified_until', { useTz: true }).nullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.string('user_agent', 255).nullable();
    t.string('ip_address', 64).nullable();
  });
  await knex.raw(
    `CREATE INDEX idx_client_sessions_identity ON client_sessions (external_identity_id)`,
  );

  await knex.schema.createTable('sms_opt_ins', (t) => {
    t.uuid('external_identity_id')
      .primary()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    t.timestamp('opted_in_at', { useTz: true }).notNullable();
    t.timestamp('opted_out_at', { useTz: true }).nullable();
    t.timestamp('last_stop_keyword_at', { useTz: true }).nullable();
    t.specificType('provider', 'sms_provider').notNullable();
    t.string('source', 128).nullable(); // "portal-form" | "email-reply" | "staff-confirmed" | etc.
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_opt_ins');
  await knex.schema.dropTableIfExists('client_sessions');
  await knex.schema.dropTableIfExists('access_codes');
  await knex.schema.dropTableIfExists('external_identities');
};
