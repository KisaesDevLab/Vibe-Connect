/**
 * Phase 26 — Client Vault schema.
 *
 * Five new tables giving every external_identity a durable, E2EE file store
 * that lives independently of any conversation:
 *
 *   client_vaults           one row per external_identity
 *   vault_keys              wrapped zone keys (shared | staff_only), versioned
 *                           on staff add/remove like conversation_keys
 *   vault_folders           one-level-deep folders inside a zone (v1)
 *   vault_files             ciphertext file rows; storage_path points at the
 *                           bytes on the appliance volume / S3 bucket
 *   vault_uploads_in_progress  tus resumable-upload state
 *
 * Crypto split (load-bearing):
 *   - file bytes: client-encrypted with a per-file XChaCha20-Poly1305 key
 *     before tus transmits; server stores ciphertext only
 *   - per-file key wrapped to the zone key (`wrapped_file_key`)
 *   - filename encrypted with the zone key (`filename_ciphertext`)
 *   - folder name encrypted with the zone key (`name_ciphertext`)
 *   - zone key wrapped per recipient in `vault_keys.wrapped_keys` JSONB,
 *     keyed exactly like conversation_keys.wrapped_keys
 *     (`${userId}:${deviceId}` for staff devices, `client:${eid}:session:${sid}`
 *     for portal sessions, `client:${eid}:invite` for pre-activation,
 *     `firm:recovery` for the firm recovery phrase)
 *   - mime_type, size_bytes, uploaded_at remain plaintext metadata (same
 *     trade-off as message attachments; documented in THREAT_MODEL.md)
 *
 * Hard zone-separation invariant: vault_keys rows for `staff_only` must
 * never carry a wrapped key for any `client:` recipient. Enforcement lives
 * in the repository layer, NOT here — the schema check would tie the DB
 * to a JSONB key-pattern check that's brittle to recipient-id refactors.
 *
 * No vault_audit_log table — vault writes flow through the existing
 * audit_log repo with target_type IN ('vault', 'vault_file', 'vault_folder',
 * 'vault_zone'). Partial index keeps the hot path lean.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('client_vaults', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('external_identity_id')
      .notNullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('CASCADE');
    // Per-vault overrides (folder template applied, retention overrides, etc.)
    t.jsonb('settings').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['external_identity_id']);
  });

  await knex.schema.createTable('vault_keys', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vault_id').notNullable().references('id').inTable('client_vaults').onDelete('CASCADE');
    t.text('zone').notNullable(); // 'shared' | 'staff_only'
    t.integer('rotation_version').notNullable();
    // {recipientId: wrappedKeyBase64}
    t.jsonb('wrapped_keys').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['vault_id', 'zone', 'rotation_version']);
  });
  await knex.raw(
    `ALTER TABLE vault_keys ADD CONSTRAINT chk_vault_keys_zone
       CHECK (zone IN ('shared', 'staff_only'))`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_keys_latest ON vault_keys (vault_id, zone, rotation_version DESC)`,
  );

  await knex.schema.createTable('vault_folders', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vault_id').notNullable().references('id').inTable('client_vaults').onDelete('CASCADE');
    // v1 keeps this null (one-level nesting). Schema is forward-compatible
    // with v2 nested folders without a migration.
    t.uuid('parent_folder_id')
      .nullable()
      .references('id')
      .inTable('vault_folders')
      .onDelete('CASCADE');
    t.text('zone').notNullable();
    t.text('name_ciphertext').notNullable(); // base64 SymmetricEnvelope under zone key
    t.integer('content_key_version').notNullable().defaultTo(1);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('deleted_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `ALTER TABLE vault_folders ADD CONSTRAINT chk_vault_folders_zone
       CHECK (zone IN ('shared', 'staff_only'))`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_folders_vault_zone
       ON vault_folders (vault_id, zone) WHERE deleted_at IS NULL`,
  );

  await knex.schema.createTable('vault_files', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vault_id').notNullable().references('id').inTable('client_vaults').onDelete('CASCADE');
    t.uuid('folder_id').nullable().references('id').inTable('vault_folders').onDelete('CASCADE');
    t.text('zone').notNullable();
    t.text('filename_ciphertext').notNullable();
    t.string('mime_type', 128).notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.string('storage_path', 1024).notNullable();
    t.binary('wrapped_file_key').notNullable();
    t.integer('content_key_version').notNullable().defaultTo(1);
    t.string('envelope_format', 32).notNullable().defaultTo('vault-zone-key-v1');
    t.string('scan_status', 32).notNullable().defaultTo('pending'); // pending|clean|infected
    t.integer('version').notNullable().defaultTo(1);
    // Reserved for v2 file versioning. Self-ref FK already in place.
    t.uuid('prior_version_id').nullable().references('id').inTable('vault_files');
    t.uuid('uploaded_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.uuid('uploaded_by_external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.timestamp('uploaded_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Per-folder retention overrides set by staff. NULL = inherit from zone /
    // firm settings (computed at sweep time).
    t.timestamp('retention_expires_at', { useTz: true }).nullable();
    t.timestamp('deleted_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `ALTER TABLE vault_files ADD CONSTRAINT chk_vault_files_zone
       CHECK (zone IN ('shared', 'staff_only'))`,
  );
  await knex.raw(
    `ALTER TABLE vault_files ADD CONSTRAINT chk_vault_files_scan_status
       CHECK (scan_status IN ('pending', 'clean', 'infected'))`,
  );
  // Exactly one of uploaded_by_user_id / uploaded_by_external_identity_id is set.
  await knex.raw(
    `ALTER TABLE vault_files ADD CONSTRAINT chk_vault_files_actor
       CHECK ((uploaded_by_user_id IS NULL) <> (uploaded_by_external_identity_id IS NULL))`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_files_vault_folder
       ON vault_files (vault_id, folder_id) WHERE deleted_at IS NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_files_scan_pending
       ON vault_files (scan_status) WHERE scan_status = 'pending'`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_files_retention
       ON vault_files (retention_expires_at)
       WHERE retention_expires_at IS NOT NULL AND deleted_at IS NULL`,
  );

  await knex.schema.createTable('vault_uploads_in_progress', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('upload_url_id').notNullable().unique(); // tus upload-id (opaque)
    t.uuid('vault_id').notNullable().references('id').inTable('client_vaults').onDelete('CASCADE');
    t.text('zone').notNullable();
    t.uuid('folder_id').nullable().references('id').inTable('vault_folders').onDelete('CASCADE');
    t.bigInteger('expected_size').notNullable();
    t.bigInteger('bytes_received').notNullable().defaultTo(0);
    t.jsonb('metadata').notNullable().defaultTo('{}'); // tus Upload-Metadata: filenameCiphertext, wrappedFileKey, mimeType
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.uuid('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.uuid('created_by_external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `ALTER TABLE vault_uploads_in_progress ADD CONSTRAINT chk_vault_uploads_zone
       CHECK (zone IN ('shared', 'staff_only'))`,
  );
  // Bind upload to its creator: tus PATCH must come from the same session.
  await knex.raw(
    `ALTER TABLE vault_uploads_in_progress ADD CONSTRAINT chk_vault_uploads_actor
       CHECK ((created_by_user_id IS NULL) <> (created_by_external_identity_id IS NULL))`,
  );
  await knex.raw(
    `CREATE INDEX idx_vault_uploads_expires ON vault_uploads_in_progress (expires_at)`,
  );

  // Audit hot-path index for vault target types. The audit_log table stays
  // shared with the rest of the app; this just keeps "show me everything
  // that ever happened to this vault file" cheap.
  await knex.raw(
    `CREATE INDEX idx_audit_log_vault_target
       ON audit_log (target_id)
       WHERE target_type IN ('vault', 'vault_file', 'vault_folder', 'vault_zone')`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_audit_log_vault_target`);
  await knex.schema.dropTableIfExists('vault_uploads_in_progress');
  await knex.schema.dropTableIfExists('vault_files');
  await knex.schema.dropTableIfExists('vault_folders');
  await knex.schema.dropTableIfExists('vault_keys');
  await knex.schema.dropTableIfExists('client_vaults');
};
