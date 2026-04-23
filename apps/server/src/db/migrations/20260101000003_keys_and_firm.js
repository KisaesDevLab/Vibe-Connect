/**
 * Per-device staff keys, firm master key, and user presence.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('user_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('device_id', 128).notNullable();
    t.text('public_key').notNullable(); // base64 X25519 public key
    t.text('encrypted_private_key').notNullable(); // Argon2id-wrapped private key
    t.jsonb('kdf_params').notNullable();
    t.text('kdf_salt').notNullable();
    t.integer('key_version').notNullable().defaultTo(1);
    t.specificType('client_platform', 'client_platform').notNullable();
    t.string('client_version', 64).nullable();
    t.timestamp('last_heartbeat_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.unique(['user_id', 'device_id']);
  });
  await knex.raw(`CREATE INDEX idx_user_keys_revoked_at ON user_keys (revoked_at)`);
  await knex.raw(
    `CREATE INDEX idx_user_keys_heartbeat ON user_keys (last_heartbeat_at DESC NULLS LAST)`,
  );

  await knex.schema.createTable('firm_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('public_key').notNullable(); // base64 X25519 public key
    t.text('encrypted_recovery_private_key').notNullable(); // wrapped by 24-word phrase
    t.jsonb('kdf_params').notNullable();
    t.text('kdf_salt').notNullable();
    t.integer('rotation_version').notNullable().defaultTo(1);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('retired_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `CREATE UNIQUE INDEX idx_firm_keys_active_singleton ON firm_keys ((retired_at IS NULL)) WHERE retired_at IS NULL`,
  );

  await knex.schema.createTable('user_presence', (t) => {
    t.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.integer('socket_count').notNullable().defaultTo(0);
    t.timestamp('last_heartbeat_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_presence');
  await knex.schema.dropTableIfExists('firm_keys');
  await knex.schema.dropTableIfExists('user_keys');
};
