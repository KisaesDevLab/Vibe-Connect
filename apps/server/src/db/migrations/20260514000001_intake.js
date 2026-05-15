/**
 * Phase 28 — Vibe File Transfer (Intake) schema.
 *
 * One migration covering every table + column the intake feature needs.
 * Kept consolidated (rather than one-table-per-file) because Phase 28's
 * tables are tightly cross-referenced — intake_links ← intake_sessions ←
 * intake_files / intake_pdfs / intake_uploads_in_progress — and the
 * down-migration must drop them in reverse order anyway.
 *
 * Encryption posture: server-side at rest with a firm-held libsodium key
 * (NOT E2EE). See docs/ADR-028-server-side-encryption-rationale.md and the
 * CLAUDE.md "Phase 28 deliberate exception" carve-out. PII columns are
 * `bytea` (libsodium secretbox blob, raw nonce || ciphertext); plaintext
 * mirror data (sizes, mime types, hashes-for-search) stays cleartext so
 * the server can sort, paginate, and filter without per-row decrypt.
 *
 * Audit: no per-feature `intake_audit_log` table. Reuses the existing
 * `audit_log` (target_id has no FK to feature tables, so audit rows
 * survive the auto-purge cascade in Phase 28.15 by construction).
 *
 * Firm settings: extends the existing singleton `firm_settings(id=1)` —
 * no separate `firm_settings_intake` table. Mirrors the Phase 26 vault
 * and Phase 28 backup-status extensions.
 */
exports.up = async function up(knex) {
  // -------- 1. Augment `users` with the staff intake-card columns --------
  await knex.schema.alterTable('users', (t) => {
    t.boolean('show_on_intake_card').notNullable().defaultTo(false);
    t.integer('intake_card_order').nullable();
    t.text('intake_card_bio').nullable(); // 280-char enforcement in services/routes
    t.text('intake_card_headshot_url').nullable();
    t.text('intake_card_title').nullable(); // 60-char enforcement in services/routes
  });
  // Partial index over opted-in staff for the public /intake landing query.
  await knex.raw(
    `CREATE INDEX idx_users_intake_card ON users (intake_card_order NULLS LAST, display_name)
       WHERE show_on_intake_card = TRUE`,
  );

  // -------- 2. Extend `firm_settings` with intake config columns --------
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('intake_auto_delete_enabled').notNullable().defaultTo(false);
    t.integer('intake_auto_delete_after_days').notNullable().defaultTo(365);
    t.boolean('intake_send_to_both_channels').notNullable().defaultTo(true);
    t.bigInteger('intake_max_file_bytes').notNullable().defaultTo(52428800); // 50 MB
    t.bigInteger('intake_max_session_bytes').notNullable().defaultTo(262144000); // 250 MB
    t.integer('intake_conversion_concurrency').notNullable().defaultTo(2);
    t.boolean('intake_include_cover_page').notNullable().defaultTo(true);
    t.integer('intake_digest_hour_local').notNullable().defaultTo(8);
    t.boolean('intake_maintenance_mode').notNullable().defaultTo(false);
  });
  // Range check for the retention window. min 30 / max 3650 per Phase 28.15.
  await knex.raw(
    `ALTER TABLE firm_settings ADD CONSTRAINT chk_intake_auto_delete_days
       CHECK (intake_auto_delete_after_days BETWEEN 30 AND 3650)`,
  );
  await knex.raw(
    `ALTER TABLE firm_settings ADD CONSTRAINT chk_intake_digest_hour
       CHECK (intake_digest_hour_local BETWEEN 0 AND 23)`,
  );
  await knex.raw(
    `ALTER TABLE firm_settings ADD CONSTRAINT chk_intake_conversion_concurrency
       CHECK (intake_conversion_concurrency BETWEEN 1 AND 16)`,
  );

  // -------- 3. intake_links (created first; intake_sessions FKs to it) --------
  await knex.schema.createTable('intake_links', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // 22 chars = 16 random bytes base64url. Unique-indexed.
    t.string('token', 32).notNullable().unique();
    t.uuid('created_by_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.uuid('assigned_staff_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.integer('use_count').notNullable().defaultTo(0);
    t.binary('client_email_enc').nullable();
    t.binary('client_phone_enc').nullable();
    t.text('note_to_client').nullable(); // 500-char enforcement in services/routes
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `CREATE INDEX idx_intake_links_active
       ON intake_links (expires_at)
       WHERE revoked_at IS NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_links_by_staff
       ON intake_links (assigned_staff_id, created_at DESC)`,
  );

  // -------- 4. intake_sessions --------
  await knex.schema.createTable('intake_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('staff_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('source').notNullable(); // 'public' | 'staff_link'
    t.uuid('token_id').nullable().references('id').inTable('intake_links').onDelete('SET NULL');
    // PII columns — encrypted via services/intakeCrypto.ts. Raw nonce || ct.
    t.binary('client_name_enc').notNullable();
    t.binary('client_email_enc').nullable();
    t.binary('client_phone_enc').nullable();
    // Deterministic HKDF-derived search hashes (Phase 28.11 staff search).
    // Cleartext base64url so SQL = lookup works; the underlying plaintext
    // is not recoverable from the hash.
    t.text('client_name_lower_hash').nullable();
    t.text('client_email_hash').nullable();
    t.text('client_phone_hash').nullable();
    t.text('contact_method').notNullable(); // 'email' | 'sms' | 'both'
    t.specificType('ip_address', 'inet').nullable();
    t.text('user_agent').nullable();
    t.text('status').notNullable().defaultTo('open'); // 'open' | 'finalized' | 'expired' | 'abandoned'
    t.text('upload_token_jti').notNullable().unique();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finalized_at', { useTz: true }).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    // Post-hoc client linking (Phase 28.11). external_identities is Connect's
    // canonical "client" table — Phase 26 vault FKs to the same row.
    t.uuid('linked_connect_client_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.uuid('linked_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('linked_at', { useTz: true }).nullable();
    // Retention / auto-purge (Phase 28.15). NULL = "never auto-delete".
    t.timestamp('auto_delete_at', { useTz: true }).nullable();
    t.boolean('notification_failed').notNullable().defaultTo(false);
  });
  await knex.raw(
    `ALTER TABLE intake_sessions ADD CONSTRAINT chk_intake_sessions_source
       CHECK (source IN ('public', 'staff_link'))`,
  );
  await knex.raw(
    `ALTER TABLE intake_sessions ADD CONSTRAINT chk_intake_sessions_status
       CHECK (status IN ('open', 'finalized', 'expired', 'abandoned'))`,
  );
  await knex.raw(
    `ALTER TABLE intake_sessions ADD CONSTRAINT chk_intake_sessions_contact_method
       CHECK (contact_method IN ('email', 'sms', 'both'))`,
  );
  // At least one of email/phone must be provided per Phase 28.4. The
  // contact_method column distinguishes which.
  await knex.raw(
    `ALTER TABLE intake_sessions ADD CONSTRAINT chk_intake_sessions_contact_present
       CHECK (client_email_enc IS NOT NULL OR client_phone_enc IS NOT NULL)`,
  );
  // tokenized sessions must have a token_id; public sessions must not.
  await knex.raw(
    `ALTER TABLE intake_sessions ADD CONSTRAINT chk_intake_sessions_token_source
       CHECK ((source = 'staff_link') = (token_id IS NOT NULL))`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_sessions_staff ON intake_sessions (staff_id, created_at DESC)`,
  );
  await knex.raw(`CREATE INDEX idx_intake_sessions_status ON intake_sessions (status, created_at)`);
  await knex.raw(
    `CREATE INDEX idx_intake_sessions_auto_delete
       ON intake_sessions (auto_delete_at)
       WHERE auto_delete_at IS NOT NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_sessions_email_hash
       ON intake_sessions (client_email_hash)
       WHERE client_email_hash IS NOT NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_sessions_phone_hash
       ON intake_sessions (client_phone_hash)
       WHERE client_phone_hash IS NOT NULL`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_sessions_name_hash
       ON intake_sessions (client_name_lower_hash)
       WHERE client_name_lower_hash IS NOT NULL`,
  );

  // -------- 5. intake_files (per-file row, ordered) --------
  await knex.schema.createTable('intake_files', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id')
      .notNullable()
      .references('id')
      .inTable('intake_sessions')
      .onDelete('CASCADE');
    t.text('original_filename').notNullable();
    t.text('stored_path').notNullable();
    t.text('mime_type').notNullable();
    t.bigInteger('size_bytes').notNullable();
    t.text('sha256').notNullable();
    t.text('kind').notNullable(); // 'file' | 'scanned_image'
    t.integer('order_index').notNullable().defaultTo(0);
    t.text('virus_scan_status').notNullable().defaultTo('pending'); // pending|clean|infected|error
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `ALTER TABLE intake_files ADD CONSTRAINT chk_intake_files_kind
       CHECK (kind IN ('file', 'scanned_image'))`,
  );
  await knex.raw(
    `ALTER TABLE intake_files ADD CONSTRAINT chk_intake_files_scan_status
       CHECK (virus_scan_status IN ('pending', 'clean', 'infected', 'error'))`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_files_session_order
       ON intake_files (session_id, order_index)`,
  );

  // -------- 6. intake_pdfs (assembled PDF, one per session) --------
  await knex.schema.createTable('intake_pdfs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id')
      .notNullable()
      .references('id')
      .inTable('intake_sessions')
      .onDelete('CASCADE');
    t.text('stored_path').nullable(); // populated after successful conversion
    t.bigInteger('size_bytes').nullable();
    t.text('sha256').nullable();
    t.integer('page_count').nullable();
    // Postgres array of uuids covering which intake_files contributed.
    t.specificType('source_file_ids', 'uuid[]').notNullable().defaultTo('{}');
    // Conversion ticker claim column (UPDATE ... RETURNING ... FOR UPDATE
    // SKIP LOCKED pattern mirroring services/scheduledMessages.ts).
    t.timestamp('conversion_started_at', { useTz: true }).nullable();
    t.text('conversion_status').notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('error_message').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `ALTER TABLE intake_pdfs ADD CONSTRAINT chk_intake_pdfs_status
       CHECK (conversion_status IN ('pending', 'processing', 'done', 'failed'))`,
  );
  // The ticker reaches for "pending and ready to attempt" rows. Partial index
  // keeps that hot path small even after the table fills up with completed
  // conversions.
  await knex.raw(
    `CREATE INDEX idx_intake_pdfs_claimable
       ON intake_pdfs (next_attempt_at)
       WHERE conversion_status = 'pending' AND conversion_started_at IS NULL`,
  );
  await knex.raw(`CREATE UNIQUE INDEX idx_intake_pdfs_session ON intake_pdfs (session_id)`);

  // -------- 7. intake_uploads_in_progress (tus state, mirror vault shape) --------
  await knex.schema.createTable('intake_uploads_in_progress', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('upload_url_id').notNullable().unique(); // tus opaque id
    t.uuid('session_id')
      .notNullable()
      .references('id')
      .inTable('intake_sessions')
      .onDelete('CASCADE');
    t.bigInteger('expected_size').notNullable();
    t.bigInteger('bytes_received').notNullable().defaultTo(0);
    t.jsonb('metadata').notNullable().defaultTo('{}'); // tus Upload-Metadata
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    `CREATE INDEX idx_intake_uploads_expires
       ON intake_uploads_in_progress (expires_at)`,
  );

  // -------- 8. intake_notifications_outbox (client + staff notify tickers) --------
  await knex.schema.createTable('intake_notifications_outbox', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id').nullable().references('id').inTable('intake_sessions').onDelete('CASCADE');
    // 'email' | 'sms' (client-side) or 'in_app' (staff-side fanout)
    t.text('channel').notNullable();
    // For email/sms: HKDF hash of the recipient address (never plaintext).
    // For in_app: the staff user_id as text (no privacy concern; rendered
    // back via the realtime fanout).
    t.text('recipient_hash').notNullable();
    t.text('template_id').notNullable();
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('last_error').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('sent_at', { useTz: true }).nullable();
  });
  await knex.raw(
    `ALTER TABLE intake_notifications_outbox ADD CONSTRAINT chk_intake_notify_channel
       CHECK (channel IN ('email', 'sms', 'in_app'))`,
  );
  await knex.raw(
    `ALTER TABLE intake_notifications_outbox ADD CONSTRAINT chk_intake_notify_status
       CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'deferred'))`,
  );
  await knex.raw(
    `CREATE INDEX idx_intake_notify_claimable
       ON intake_notifications_outbox (next_attempt_at)
       WHERE status IN ('pending', 'deferred')`,
  );

  // -------- 9. intake_key_rotations (Phase 28.16 rotation job state) --------
  await knex.schema.createTable('intake_key_rotations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.text('status').notNullable().defaultTo('running');
    t.integer('total_sessions').notNullable().defaultTo(0);
    t.integer('processed_sessions').notNullable().defaultTo(0);
    t.integer('total_files').notNullable().defaultTo(0);
    t.integer('processed_files').notNullable().defaultTo(0);
    t.integer('total_pdfs').notNullable().defaultTo(0);
    t.integer('processed_pdfs').notNullable().defaultTo(0);
    t.uuid('last_processed_session_id').nullable();
    t.text('error_message').nullable();
    t.uuid('started_by_user_id').notNullable().references('id').inTable('users');
    t.boolean('dry_run').notNullable().defaultTo(false);
  });
  await knex.raw(
    `ALTER TABLE intake_key_rotations ADD CONSTRAINT chk_intake_key_rotations_status
       CHECK (status IN ('running', 'paused', 'completed', 'failed'))`,
  );

  // -------- 10. intake_session_archives (per-staff archive + read state) --------
  await knex.schema.createTable('intake_session_archives', (t) => {
    t.uuid('session_id')
      .notNullable()
      .references('id')
      .inTable('intake_sessions')
      .onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('archived_at', { useTz: true }).nullable();
    // read state collapses into the same table so a "mark read" doesn't
    // create a second row; archived + read are mutually orthogonal.
    t.timestamp('read_at', { useTz: true }).nullable();
    t.primary(['session_id', 'user_id']);
  });

  // -------- 11. Audit hot-path index for intake-namespaced actions --------
  await knex.raw(
    `CREATE INDEX idx_audit_log_intake
       ON audit_log (target_id, created_at DESC)
       WHERE target_type IN ('intake_session', 'intake_link', 'intake_card', 'intake_settings', 'intake_key_rotation')`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_audit_log_intake`);
  await knex.schema.dropTableIfExists('intake_session_archives');
  await knex.schema.dropTableIfExists('intake_key_rotations');
  await knex.schema.dropTableIfExists('intake_notifications_outbox');
  await knex.schema.dropTableIfExists('intake_uploads_in_progress');
  await knex.schema.dropTableIfExists('intake_pdfs');
  await knex.schema.dropTableIfExists('intake_files');
  await knex.schema.dropTableIfExists('intake_sessions');
  await knex.schema.dropTableIfExists('intake_links');

  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropChecks?.([
      'chk_intake_auto_delete_days',
      'chk_intake_digest_hour',
      'chk_intake_conversion_concurrency',
    ]);
  });
  // Knex's dropChecks isn't reliable across versions; issue raw DROP CONSTRAINT
  // calls too so down-migration succeeds regardless of dialect helper coverage.
  await knex.raw(`ALTER TABLE firm_settings DROP CONSTRAINT IF EXISTS chk_intake_auto_delete_days`);
  await knex.raw(`ALTER TABLE firm_settings DROP CONSTRAINT IF EXISTS chk_intake_digest_hour`);
  await knex.raw(
    `ALTER TABLE firm_settings DROP CONSTRAINT IF EXISTS chk_intake_conversion_concurrency`,
  );
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('intake_maintenance_mode');
    t.dropColumn('intake_digest_hour_local');
    t.dropColumn('intake_include_cover_page');
    t.dropColumn('intake_conversion_concurrency');
    t.dropColumn('intake_max_session_bytes');
    t.dropColumn('intake_max_file_bytes');
    t.dropColumn('intake_send_to_both_channels');
    t.dropColumn('intake_auto_delete_after_days');
    t.dropColumn('intake_auto_delete_enabled');
  });

  await knex.raw(`DROP INDEX IF EXISTS idx_users_intake_card`);
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('intake_card_title');
    t.dropColumn('intake_card_headshot_url');
    t.dropColumn('intake_card_bio');
    t.dropColumn('intake_card_order');
    t.dropColumn('show_on_intake_card');
  });
};
