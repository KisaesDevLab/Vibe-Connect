/**
 * Per-conversation email tokens. Each conversation gets a random 16-char token; inbound
 * email to `c+<token>@connect.<firm>` lands in that conversation.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('conversation_email_tokens', (t) => {
    t.uuid('conversation_id')
      .primary()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.string('token', 32).notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('conversation_email_tokens');
};
