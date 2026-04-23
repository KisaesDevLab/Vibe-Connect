/**
 * Messages, attachments, read receipts.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.uuid('sender_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.uuid('sender_external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.binary('ciphertext').notNullable();
    t.integer('content_key_version').notNullable();
    t.boolean('urgent').notNullable().defaultTo(false);
    t.timestamp('scheduled_for', { useTz: true }).nullable();
    t.specificType('source', 'message_source').notNullable().defaultTo('app');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('edited_at', { useTz: true }).nullable();
    t.timestamp('deleted_at', { useTz: true }).nullable();
    // Preserve original IV/header metadata needed for edit rules
    t.jsonb('ciphertext_meta').notNullable().defaultTo('{}');
    // Source-specific metadata (email In-Reply-To, SMS provider message id, etc.)
    t.jsonb('source_meta').notNullable().defaultTo('{}');
  });
  await knex.raw(
    `CREATE INDEX idx_messages_conv_created ON messages (conversation_id, created_at DESC)`,
  );
  await knex.raw(
    `CREATE INDEX idx_messages_scheduled ON messages (scheduled_for) WHERE scheduled_for IS NOT NULL AND deleted_at IS NULL`,
  );
  await knex.raw(`CREATE INDEX idx_messages_urgent ON messages (urgent) WHERE urgent = true`);
  // At least one sender must be set (unless system source)
  await knex.raw(`ALTER TABLE messages ADD CONSTRAINT chk_message_sender
    CHECK (source = 'system' OR (sender_id IS NOT NULL) <> (sender_external_identity_id IS NOT NULL))`);

  await knex.schema.createTable('attachments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('message_id').notNullable().references('id').inTable('messages').onDelete('CASCADE');
    t.text('filename_ciphertext').notNullable();
    t.string('mime_type', 128).notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.string('storage_path', 1024).notNullable();
    t.binary('wrapped_file_key').notNullable();
    t.string('scan_status', 32).notNullable().defaultTo('pending'); // pending|clean|infected
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_attachments_message ON attachments (message_id)`);

  await knex.schema.createTable('read_receipts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('message_id').notNullable().references('id').inTable('messages').onDelete('CASCADE');
    t.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    t.timestamp('read_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE read_receipts ADD CONSTRAINT chk_receipt_actor
    CHECK ((user_id IS NULL) <> (external_identity_id IS NULL))`);
  await knex.raw(
    `CREATE UNIQUE INDEX idx_receipt_user ON read_receipts (message_id, user_id) WHERE user_id IS NOT NULL`,
  );
  await knex.raw(
    `CREATE UNIQUE INDEX idx_receipt_external ON read_receipts (message_id, external_identity_id) WHERE external_identity_id IS NOT NULL`,
  );

  // Now that messages exists, add the FK from conversation_members.last_read_message_id.
  await knex.raw(`
    ALTER TABLE conversation_members
    ADD CONSTRAINT fk_last_read_message
    FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS fk_last_read_message`);
  await knex.schema.dropTableIfExists('read_receipts');
  await knex.schema.dropTableIfExists('attachments');
  await knex.schema.dropTableIfExists('messages');
};
