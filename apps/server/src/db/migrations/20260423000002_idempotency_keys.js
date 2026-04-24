/**
 * Per-user idempotency store for duplicate-suppression on POST /conversations/:id/messages.
 *
 * The client sends `X-Idempotency-Key: <uuid>` with each send. On re-submission (network
 * retry) we return the same response we returned the first time instead of creating a
 * duplicate message row.
 *
 * Scoped per user (rather than global) so two users can't collide on the same uuid.
 * Rows older than 24h are no longer needed — a periodic cleanup sweeps them.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('idempotency_keys', (t) => {
    t.string('key', 128).notNullable();
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('message_id').nullable().references('id').inTable('messages').onDelete('CASCADE');
    t.jsonb('response').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['key', 'user_id']);
  });
  await knex.raw(`CREATE INDEX idx_idempotency_created_at ON idempotency_keys (created_at)`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_idempotency_created_at`);
  await knex.schema.dropTableIfExists('idempotency_keys');
};
