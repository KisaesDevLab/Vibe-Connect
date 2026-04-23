/**
 * Users, groups, user_groups. Staff identity foundation.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('username', 64).notNullable().unique();
    t.string('email', 255).nullable();
    t.string('password_hash', 255).notNullable();
    t.string('display_name', 128).notNullable();
    t.string('avatar_url', 255).nullable();
    t.boolean('is_admin').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.specificType('status', 'user_status').notNullable().defaultTo('offline');
    t.timestamp('last_seen_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_users_is_active ON users (is_active)`);
  await knex.raw(`CREATE INDEX idx_users_last_seen_at ON users (last_seen_at DESC NULLS LAST)`);

  await knex.schema.createTable('groups', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 80).notNullable().unique();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_groups_sort_order ON groups (sort_order)`);

  await knex.schema.createTable('user_groups', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'group_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_groups');
  await knex.schema.dropTableIfExists('groups');
  await knex.schema.dropTableIfExists('users');
};
