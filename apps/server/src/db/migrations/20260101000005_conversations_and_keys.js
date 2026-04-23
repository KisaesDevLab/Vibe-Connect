/**
 * Conversations, members, per-conversation wrapped keys.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('conversations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.specificType('type', 'conversation_type').notNullable();
    t.uuid('parent_conversation_id')
      .nullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.string('display_name', 255).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_conversations_type ON conversations (type)`);
  await knex.raw(
    `CREATE INDEX idx_conversations_parent ON conversations (parent_conversation_id) WHERE parent_conversation_id IS NOT NULL`,
  );
  await knex.raw(`CREATE INDEX idx_conversations_updated_at ON conversations (updated_at DESC)`);

  // Integrity: internal_thread must have a parent; external/internal must not.
  await knex.raw(`ALTER TABLE conversations ADD CONSTRAINT chk_thread_parent
    CHECK ((type = 'internal_thread' AND parent_conversation_id IS NOT NULL)
        OR (type <> 'internal_thread' AND parent_conversation_id IS NULL))`);

  await knex.schema.createTable('conversation_members', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    t.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('last_read_message_id').nullable();
    t.timestamp('muted_until', { useTz: true }).nullable();
    t.timestamp('removed_at', { useTz: true }).nullable();
  });
  // Exactly one of user_id / external_identity_id must be set.
  await knex.raw(`ALTER TABLE conversation_members ADD CONSTRAINT chk_member_actor
    CHECK ((user_id IS NULL) <> (external_identity_id IS NULL))`);
  await knex.raw(
    `CREATE UNIQUE INDEX idx_conv_members_user ON conversation_members (conversation_id, user_id)
     WHERE user_id IS NOT NULL AND removed_at IS NULL`,
  );
  await knex.raw(
    `CREATE UNIQUE INDEX idx_conv_members_external ON conversation_members (conversation_id, external_identity_id)
     WHERE external_identity_id IS NOT NULL AND removed_at IS NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_conv_members_user_all ON conversation_members (user_id) WHERE user_id IS NOT NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_conv_members_external_all ON conversation_members (external_identity_id) WHERE external_identity_id IS NOT NULL`,
  );

  await knex.schema.createTable('conversation_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.integer('rotation_version').notNullable();
    t.jsonb('wrapped_keys').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['conversation_id', 'rotation_version']);
  });
  await knex.raw(
    `CREATE INDEX idx_conversation_keys_latest ON conversation_keys (conversation_id, rotation_version DESC)`,
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('conversation_keys');
  await knex.schema.dropTableIfExists('conversation_members');
  await knex.schema.dropTableIfExists('conversations');
};
