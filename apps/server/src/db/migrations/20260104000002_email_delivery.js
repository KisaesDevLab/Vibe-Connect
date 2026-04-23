exports.up = async function up(knex) {
  await knex.schema.createTable('email_deliveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('message_id').nullable().references('id').inTable('messages').onDelete('SET NULL');
    t.uuid('recipient_external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.string('provider_id', 128).nullable();
    t.string('status', 32).notNullable().defaultTo('sent');
    t.jsonb('details').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `CREATE INDEX idx_email_deliveries_recipient ON email_deliveries (recipient_external_identity_id, created_at DESC)`,
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_deliveries');
};
