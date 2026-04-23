/**
 * Add acknowledgements. Separate from read_receipts so "I read it" stays distinct from
 * "I acknowledge the action".
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('message_acks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('message_id').notNullable().references('id').inTable('messages').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('acked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['message_id', 'user_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('message_acks');
};
