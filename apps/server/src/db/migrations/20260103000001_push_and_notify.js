/**
 * Push subscriptions + per-user notification preferences (DND schedule + urgent override).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('push_subscriptions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('endpoint', 1024).notNullable();
    t.string('p256dh', 512).notNullable();
    t.string('auth', 256).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'endpoint']);
  });

  await knex.schema.createTable('notification_prefs', (t) => {
    t.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('dnd_enabled').notNullable().defaultTo(false);
    t.string('dnd_start', 5).notNullable().defaultTo('20:00'); // HH:MM local
    t.string('dnd_end', 5).notNullable().defaultTo('08:00');
    t.string('timezone', 64).notNullable().defaultTo('UTC');
    t.boolean('urgent_overrides_dnd').notNullable().defaultTo(true);
    t.boolean('email_fallback_enabled').notNullable().defaultTo(true);
    t.integer('email_fallback_urgent_only').notNullable().defaultTo(1); // 0=false,1=true
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('notification_prefs');
  await knex.schema.dropTableIfExists('push_subscriptions');
};
