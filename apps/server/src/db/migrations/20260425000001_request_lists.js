/**
 * Phase 24: Client Requests & Document Collection — schema.
 *
 * Three new tables: request_lists, request_items, request_templates.
 *
 * Crypto split (load-bearing — see plan):
 *   list-level title + description: cleartext, so the server can render
 *     progress, template nudge bodies, and show the portal's Requests tab
 *     before the client unwraps the conversation key.
 *   item-level title + description + revision_note: E2EE under the
 *     conversation's existing content key (same envelope used for messages).
 *     Stored as bytea ciphertext blobs alongside content_key_version so the
 *     decrypting client knows which wrapped key to use.
 *   status fields: cleartext (server enforces the state machine).
 *
 * No `messages` table changes — request item linkage and system-event types
 * live on the existing `messages.ciphertext_meta` JSONB blob (capped at 4 KB
 * by the boundedMeta zod schema in routes/conversations.ts). Reserved keys:
 * requestItemId, requestListId, systemEventType, revisionNoteCiphertext.
 *
 * Single-firm appliance: no firm_id columns; templates are firm-scoped
 * implicitly via the singleton firm_settings row.
 */
exports.up = async function up(knex) {
  // request_templates is referenced by request_lists.template_id, so create
  // it first to satisfy the FK at table-creation time.
  await knex.schema.createTable('request_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 120).notNullable();
    t.text('description').nullable();
    // [{title, description?, response_type, sort_order, default_due_offset_days?}]
    t.jsonb('item_specs').notNullable().defaultTo('[]');
    t.uuid('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('archived_at', { useTz: true }).nullable();
  });
  // Unique on active templates only — archiving frees the name for reuse.
  await knex.raw(
    `CREATE UNIQUE INDEX idx_request_templates_name_active
       ON request_templates (name) WHERE archived_at IS NULL`,
  );

  await knex.schema.createTable('request_lists', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    t.text('title').notNullable(); // cleartext
    t.text('description').nullable(); // cleartext
    t.date('due_date').nullable();
    t.text('status').notNullable().defaultTo('active');
    t.uuid('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.uuid('template_id')
      .nullable()
      .references('id')
      .inTable('request_templates')
      .onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `ALTER TABLE request_lists ADD CONSTRAINT chk_request_lists_status
       CHECK (status IN ('active', 'completed', 'archived', 'cancelled'))`,
  );
  await knex.raw(`CREATE INDEX idx_request_lists_conversation ON request_lists (conversation_id)`);
  // Common hot-path: "any active list for this conversation?" — partial index
  // keeps the index lean since most rows historically will be terminal.
  await knex.raw(
    `CREATE INDEX idx_request_lists_active
       ON request_lists (conversation_id) WHERE status = 'active'`,
  );

  await knex.schema.createTable('request_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('list_id').notNullable().references('id').inTable('request_lists').onDelete('CASCADE');
    t.binary('title_ciphertext').notNullable(); // E2EE
    t.binary('description_ciphertext').nullable(); // E2EE
    t.binary('revision_note_ciphertext').nullable(); // E2EE; latest revision only
    t.integer('content_key_version').notNullable();
    t.text('response_type').notNullable().defaultTo('both');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.date('due_date').nullable();
    t.timestamp('submitted_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.uuid('completed_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `ALTER TABLE request_items ADD CONSTRAINT chk_request_items_response_type
       CHECK (response_type IN ('file', 'text', 'both'))`,
  );
  await knex.raw(
    `ALTER TABLE request_items ADD CONSTRAINT chk_request_items_status
       CHECK (status IN ('pending', 'submitted', 'done', 'revision'))`,
  );
  await knex.raw(`CREATE INDEX idx_request_items_list_sort ON request_items (list_id, sort_order)`);
  await knex.raw(`CREATE INDEX idx_request_items_list_status ON request_items (list_id, status)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('request_items');
  await knex.schema.dropTableIfExists('request_lists');
  await knex.schema.dropTableIfExists('request_templates');
};
