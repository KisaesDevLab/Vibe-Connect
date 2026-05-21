// Phase 28 — Vibe File Transfer (Intake) repositories.
//
// Thin query wrappers over the Phase 28.1 schema. Row interfaces are
// authoritative for typed access from services / routes; business logic
// (encryption, validation, audit, fanout) lives one layer up so this
// module stays test-friendly.
//
// Methods are added as the sub-phases that need them land — 28.1 ships only
// the row types + a single read-only helper for staff card listing (used
// by Phase 28.3's public endpoint). Subsequent sub-phases (28.2 settings,
// 28.4 session create, 28.5 upload finalize, ...) extend this file rather
// than introducing parallel modules.
import type { Knex } from 'knex';
import { db } from '../db/knex.js';

// -------- Row types (one per Phase 28.1 table or augmented table) --------

export type IntakeSessionStatus = 'open' | 'finalized' | 'expired' | 'abandoned';
export type IntakeSessionSource = 'public' | 'staff_link';
export type IntakeContactMethod = 'email' | 'sms' | 'both';
export type IntakeFileKind = 'file' | 'scanned_image';
export type IntakeVirusScanStatus = 'pending' | 'clean' | 'infected' | 'error';
export type IntakePdfConversionStatus = 'pending' | 'processing' | 'done' | 'failed';
export type IntakeNotificationChannel = 'email' | 'sms' | 'in_app';
export type IntakeNotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'deferred';
export type IntakeKeyRotationStatus = 'running' | 'paused' | 'completed' | 'failed';

/**
 * Staff intake-card columns added to `users`. Row interfaces for other
 * users.* columns live in their existing repositories — this slim shape is
 * what Phase 28.2 and 28.3 read/write directly.
 */
export interface IntakeCardFields {
  show_on_intake_card: boolean;
  intake_card_order: number | null;
  intake_card_bio: string | null;
  intake_card_headshot_url: string | null;
  intake_card_title: string | null;
  // Phase 28.12 (QA-followup): per-staff notification preference. Added by
  // migration 20260515000001. Default 'realtime' matches the pre-feature
  // behaviour where every finalize emailed the assignee.
  intake_notify_mode: 'realtime' | 'digest' | 'in_app_only';
}

/**
 * Public shape returned by `GET /api/public/intake/staff` (Phase 28.3).
 * Excludes every internal field that could leak organisational structure
 * (role, email, last_login, etc.). The selection is enforced server-side
 * by `intakeCardsRepo.publicListing` — never hand-roll a query against
 * `users` for this endpoint or risk re-introducing the leak.
 */
export interface PublicIntakeCard {
  id: string;
  display_name: string;
  title: string | null;
  bio: string | null;
  headshot_url: string | null;
  order: number | null;
}

export interface IntakeLinkRow {
  id: string;
  token: string;
  created_by_user_id: string;
  assigned_staff_id: string;
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
  client_email_enc: Buffer | null;
  client_phone_enc: Buffer | null;
  note_to_client: string | null;
  created_at: string;
}

export interface IntakeSessionRow {
  id: string;
  staff_id: string;
  source: IntakeSessionSource;
  token_id: string | null;
  client_name_enc: Buffer;
  client_email_enc: Buffer | null;
  client_phone_enc: Buffer | null;
  /** Optional free-text message from the client. Encrypted with the intake
   *  key (libsodium secretbox); no companion search hash because messages
   *  are free-form. NULL when the client didn't fill the field. */
  client_message_enc: Buffer | null;
  client_name_lower_hash: string | null;
  client_email_hash: string | null;
  client_phone_hash: string | null;
  contact_method: IntakeContactMethod;
  ip_address: string | null;
  user_agent: string | null;
  status: IntakeSessionStatus;
  upload_token_jti: string;
  created_at: string;
  finalized_at: string | null;
  expires_at: string;
  linked_connect_client_id: string | null;
  linked_by_user_id: string | null;
  linked_at: string | null;
  auto_delete_at: string | null;
  notification_failed: boolean;
}

export interface IntakeFileRow {
  id: string;
  session_id: string;
  original_filename: string;
  stored_path: string;
  mime_type: string;
  // bigint deserialises as string via node-postgres; callers cast as needed.
  size_bytes: string | number;
  sha256: string;
  kind: IntakeFileKind;
  order_index: number;
  virus_scan_status: IntakeVirusScanStatus;
  // JSONB carrying the four-corner quad + enhance mode for server-side
  // warp. NULL for regular uploads, for OS-camera passthroughs, and for
  // legacy rows uploaded before the migration. See `intakeScannerWarp.ts`.
  scanner_meta: Record<string, unknown> | null;
  created_at: string;
}

export interface IntakePdfRow {
  id: string;
  session_id: string;
  stored_path: string | null;
  size_bytes: string | number | null;
  sha256: string | null;
  page_count: number | null;
  source_file_ids: string[];
  conversion_started_at: string | null;
  conversion_status: IntakePdfConversionStatus;
  attempts: number;
  next_attempt_at: string;
  error_message: string | null;
  created_at: string;
}

export interface IntakeUploadRow {
  id: string;
  upload_url_id: string;
  session_id: string;
  expected_size: string | number;
  bytes_received: string | number;
  metadata: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

export interface IntakeNotificationOutboxRow {
  id: string;
  session_id: string | null;
  channel: IntakeNotificationChannel;
  recipient_hash: string;
  template_id: string;
  payload: Record<string, unknown>;
  status: IntakeNotificationStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface IntakeKeyRotationRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: IntakeKeyRotationStatus;
  total_sessions: number;
  processed_sessions: number;
  total_files: number;
  processed_files: number;
  total_pdfs: number;
  processed_pdfs: number;
  last_processed_session_id: string | null;
  error_message: string | null;
  started_by_user_id: string;
  dry_run: boolean;
}

export interface IntakeSessionArchiveRow {
  session_id: string;
  user_id: string;
  archived_at: string | null;
  read_at: string | null;
}

// -------- Phase 28.1 read-only helpers --------
//
// Phase 28.3 (public landing) is the first endpoint that touches intake
// data — it needs an opted-in staff list. Every other repo method gets
// added by the sub-phase that needs it (28.2 settings, 28.4 session
// create, ...). Keeping additions co-located with their consumer lands
// fewer "what does this do?" review questions per sub-phase.

/**
 * Admin view of an intake card. Includes every field plus the staff user's
 * display name and admin flag so the Phase 28.2 admin reorder page can
 * render context without a second fetch. Distinct from `PublicIntakeCard`
 * — admin views are gated by `requireAdmin`; public views are anonymous.
 */
export interface AdminIntakeCard {
  user_id: string;
  display_name: string;
  is_admin: boolean;
  show_on_intake_card: boolean;
  intake_card_order: number | null;
  intake_card_bio: string | null;
  intake_card_headshot_url: string | null;
  intake_card_title: string | null;
}

export const intakeCardsRepo = {
  /**
   * Public listing for `/api/public/intake/staff` (Phase 28.3). Only
   * opted-in users, ordered by `intake_card_order` (NULLs last) then
   * `display_name` ascending. The column list is the projection that
   * leaves the server — adding any new field here without a 28.3 audit
   * pass risks leaking org structure to anonymous visitors.
   */
  async publicListing(trx?: Knex.Transaction): Promise<PublicIntakeCard[]> {
    const rows = await (trx ?? db)('users')
      .where({ show_on_intake_card: true })
      .andWhere({ is_active: true })
      .select<
        Array<{
          id: string;
          display_name: string;
          title: string | null;
          bio: string | null;
          headshot_url: string | null;
          order: number | null;
        }>
      >([
        'id',
        'display_name',
        { title: 'intake_card_title' },
        { bio: 'intake_card_bio' },
        { headshot_url: 'intake_card_headshot_url' },
        { order: 'intake_card_order' },
      ])
      .orderByRaw('intake_card_order NULLS LAST, display_name ASC');
    return rows;
  },

  /** Self-view for `GET /users/me/intake-card`. */
  async getForUser(userId: string, trx?: Knex.Transaction): Promise<IntakeCardFields | null> {
    const row = await (trx ?? db)('users')
      .where({ id: userId })
      .first<
        IntakeCardFields | undefined
      >(['show_on_intake_card', 'intake_card_order', 'intake_card_bio', 'intake_card_headshot_url', 'intake_card_title', 'intake_notify_mode']);
    return row ?? null;
  },

  /**
   * Self-write for `PATCH /users/me/intake-card`. Only the user-editable
   * fields land here; `intake_card_order` is admin-only (`reorder` below).
   * Length enforcement happens at the route layer via Zod — the DB columns
   * are TEXT to keep migrations idempotent across firm bumps to the limits.
   */
  async updateForUser(
    userId: string,
    patch: Partial<
      Pick<
        IntakeCardFields,
        | 'show_on_intake_card'
        | 'intake_card_bio'
        | 'intake_card_title'
        | 'intake_card_headshot_url'
        | 'intake_notify_mode'
      >
    >,
    trx?: Knex.Transaction,
  ): Promise<IntakeCardFields | null> {
    if (Object.keys(patch).length === 0) return this.getForUser(userId, trx);
    const [row] = await (trx ?? db)('users')
      .where({ id: userId })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning<IntakeCardFields[]>([
        'show_on_intake_card',
        'intake_card_order',
        'intake_card_bio',
        'intake_card_headshot_url',
        'intake_card_title',
        'intake_notify_mode',
      ]);
    return row ?? null;
  },

  /**
   * Admin listing for `GET /admin/intake-cards`. Returns ALL staff (opted-in
   * or not) so the admin reorder UI can promote currently-hidden staff into
   * the card grid without a separate flow. Inactive users excluded — they
   * have no business appearing on a "current staff" admin surface.
   */
  async adminListing(trx?: Knex.Transaction): Promise<AdminIntakeCard[]> {
    return (trx ?? db)('users')
      .where({ is_active: true })
      .select<AdminIntakeCard[]>([
        { user_id: 'id' },
        'display_name',
        'is_admin',
        'show_on_intake_card',
        'intake_card_order',
        'intake_card_bio',
        'intake_card_headshot_url',
        'intake_card_title',
      ])
      .orderByRaw('intake_card_order NULLS LAST, display_name ASC');
  },

  /**
   * Thrown by `batchReorder` when any item targets a userId that does not
   * exist or has been deactivated. The route surfaces this as a 400 with
   * the missing list; admins re-try after pruning stale ids out of their
   * drag-reorder draft. Class form (rather than a tagged plain Error) so
   * `err instanceof ReorderUnknownUsersError` is the type-narrowing path.
   */
  ReorderUnknownUsersError: class ReorderUnknownUsersError extends Error {
    constructor(public readonly missing: string[]) {
      super(`reorder targets ${missing.length} unknown or inactive user(s)`);
      this.name = 'ReorderUnknownUsersError';
    }
  },

  /**
   * Admin batch reorder. Each item assigns one user's `intake_card_order`.
   * Wrapped in a transaction with a pre-flight check so a partial-mismatch
   * batch leaves order untouched and returns a useful 400 to the caller —
   * the previous loop-then-count shape silently dropped writes whose
   * target rows didn't exist or were deactivated, making the UI's
   * "Saved." toast lie about what was persisted.
   *
   * Items not present in the batch keep whatever order they had; the admin
   * UI is responsible for sending every visible row, not just the moved one.
   */
  async batchReorder(
    items: Array<{ userId: string; order: number | null }>,
    trx?: Knex.Transaction,
  ): Promise<{ touched: number }> {
    if (items.length === 0) return { touched: 0 };
    const runner = trx ?? db;
    return runner.transaction(async (t) => {
      const ids = items.map((i) => i.userId);
      const presentRows = await t('users')
        .where({ is_active: true })
        .whereIn('id', ids)
        .pluck('id');
      const presentSet = new Set<string>(presentRows);
      const missing = ids.filter((id) => !presentSet.has(id));
      if (missing.length > 0) {
        throw new this.ReorderUnknownUsersError(missing);
      }
      for (const item of items) {
        await t('users')
          .where({ id: item.userId })
          .update({ intake_card_order: item.order, updated_at: db.fn.now() });
      }
      return { touched: items.length };
    });
  },

  /**
   * Count of opted-in active staff. Used by `GET /admin/intake/status` to
   * power the empty-state banner in Phase 28.11 ("`/intake` is empty — no
   * staff opted in yet").
   */
  async countOptedIn(trx?: Knex.Transaction): Promise<number> {
    const row = await (trx ?? db)('users')
      .where({ show_on_intake_card: true })
      .andWhere({ is_active: true })
      .count<{ count: string }>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  },
};

/**
 * Insert shape for `intakeSessionsRepo.create`. Mirrors the columns in
 * the 28.1 migration: PII is already encrypted (Buffer) before this layer
 * sees it; search-hash columns are deterministic base64url strings produced
 * by `intakeCrypto.searchHash`.
 */
export interface IntakeSessionInsert {
  staff_id: string;
  source: IntakeSessionSource;
  token_id: string | null;
  client_name_enc: Buffer;
  client_email_enc: Buffer | null;
  client_phone_enc: Buffer | null;
  client_message_enc?: Buffer | null;
  client_name_lower_hash: string | null;
  client_email_hash: string | null;
  client_phone_hash: string | null;
  contact_method: IntakeContactMethod;
  ip_address: string | null;
  user_agent: string | null;
  upload_token_jti: string;
  expires_at: string | Date;
}

export const intakeSessionsRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<IntakeSessionRow>('intake_sessions').where({ id }).first();
  },

  /**
   * Lookup by the JWT id stored in the upload token. The tus PATCH route
   * (Phase 28.5) uses this to verify the bearer's token still maps to a
   * session row whose `upload_token_jti` column hasn't been rotated by
   * finalize / abandon. The UNIQUE constraint on `upload_token_jti` means
   * exactly one row ever matches a given jti.
   */
  byUploadTokenJti(jti: string, trx?: Knex.Transaction) {
    return (trx ?? db)<IntakeSessionRow>('intake_sessions')
      .where({ upload_token_jti: jti })
      .first();
  },

  /**
   * Mark a session as `finalized` (idempotent). Returns the post-update
   * row, or `null` if the session id is unknown. Wrapped in a callable so
   * the route doesn't have to know the column-name details.
   */
  async finalize(id: string, trx?: Knex.Transaction): Promise<IntakeSessionRow | null> {
    const [row] = await (trx ?? db)<IntakeSessionRow>('intake_sessions')
      .where({ id })
      .update({ status: 'finalized', finalized_at: db.fn.now() })
      .returning('*');
    return row ?? null;
  },

  async create(input: IntakeSessionInsert, trx?: Knex.Transaction): Promise<IntakeSessionRow> {
    // expires_at is a timestamptz column; knex's typed-table flow expects
    // a string in the column shape (postgres-coerced to timestamp on read).
    // Accept Date here for caller ergonomics and ISO-stringify before
    // handing to knex.
    const expiresAtStr =
      input.expires_at instanceof Date ? input.expires_at.toISOString() : input.expires_at;
    const [row] = await (trx ?? db)<IntakeSessionRow>('intake_sessions')
      .insert({
        staff_id: input.staff_id,
        source: input.source,
        token_id: input.token_id,
        client_name_enc: input.client_name_enc,
        client_email_enc: input.client_email_enc,
        client_phone_enc: input.client_phone_enc,
        client_message_enc: input.client_message_enc ?? null,
        client_name_lower_hash: input.client_name_lower_hash,
        client_email_hash: input.client_email_hash,
        client_phone_hash: input.client_phone_hash,
        contact_method: input.contact_method,
        ip_address: input.ip_address,
        user_agent: input.user_agent,
        status: 'open',
        upload_token_jti: input.upload_token_jti,
        expires_at: expiresAtStr,
      })
      .returning('*');
    return row!;
  },
};

// -------- intake_uploads_in_progress (tus state) --------

export interface IntakeUploadInsert {
  upload_url_id: string;
  session_id: string;
  expected_size: number;
  metadata: Record<string, string>;
  expires_at: string;
}

export const intakeUploadsRepo = {
  byUploadUrlId(uploadUrlId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<IntakeUploadRow>('intake_uploads_in_progress')
      .where({ upload_url_id: uploadUrlId })
      .first();
  },
  async insert(input: IntakeUploadInsert, trx?: Knex.Transaction): Promise<IntakeUploadRow> {
    const [row] = await (trx ?? db)<IntakeUploadRow>('intake_uploads_in_progress')
      .insert({
        upload_url_id: input.upload_url_id,
        session_id: input.session_id,
        expected_size: input.expected_size,
        metadata: JSON.stringify(input.metadata) as unknown as never,
        expires_at: input.expires_at,
      })
      .returning('*');
    return row!;
  },
  async setBytesReceived(
    uploadUrlId: string,
    bytesReceived: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx ?? db)('intake_uploads_in_progress')
      .where({ upload_url_id: uploadUrlId })
      .update({ bytes_received: bytesReceived });
  },
  async deleteByUploadUrlId(uploadUrlId: string, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('intake_uploads_in_progress').where({ upload_url_id: uploadUrlId }).del();
  },
  async reapExpired(trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('intake_uploads_in_progress').where('expires_at', '<', db.fn.now()).del();
  },
};

// -------- intake_files (assembled-on-disk file rows) --------

export interface IntakeFileInsert {
  session_id: string;
  original_filename: string;
  stored_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  kind: IntakeFileKind;
  order_index?: number;
  virus_scan_status?: IntakeVirusScanStatus;
  scanner_meta?: Record<string, unknown> | null;
}

export const intakeFilesRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<IntakeFileRow>('intake_files').where({ id }).first();
  },
  async listBySession(sessionId: string, trx?: Knex.Transaction): Promise<IntakeFileRow[]> {
    return (trx ?? db)<IntakeFileRow>('intake_files')
      .where({ session_id: sessionId })
      .orderBy('order_index', 'asc');
  },
  /**
   * Sum of accepted (clean / pending-scan) bytes against a session. Used
   * by the tus create gate to enforce `firm_settings.intake_max_session_bytes`
   * before accepting another file. Infected files (already deleted from
   * disk by the upload service) don't count toward the cap.
   */
  async sumSizeBySession(sessionId: string, trx?: Knex.Transaction): Promise<number> {
    const row = await (trx ?? db)('intake_files')
      .where({ session_id: sessionId })
      .whereNot({ virus_scan_status: 'infected' })
      .sum<{ total: string | null }>({ total: 'size_bytes' })
      .first();
    return Number(row?.total ?? 0);
  },
  async insert(input: IntakeFileInsert, trx?: Knex.Transaction): Promise<IntakeFileRow> {
    const [row] = await (trx ?? db)<IntakeFileRow>('intake_files')
      .insert({
        session_id: input.session_id,
        original_filename: input.original_filename,
        stored_path: input.stored_path,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        sha256: input.sha256,
        kind: input.kind,
        order_index: input.order_index ?? 0,
        virus_scan_status: input.virus_scan_status ?? 'pending',
        // pg's JSONB column accepts a serialised string OR an object; we
        // pass through whatever the caller assembled. NULL when absent so
        // the column stays NULLable rather than {}.
        scanner_meta:
          input.scanner_meta === undefined
            ? null
            : (JSON.stringify(input.scanner_meta) as unknown as never),
      })
      .returning('*');
    return row!;
  },
  async setScanStatus(
    id: string,
    status: IntakeVirusScanStatus,
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx ?? db)('intake_files').where({ id }).update({ virus_scan_status: status });
  },
  async deleteById(id: string, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('intake_files').where({ id }).del();
  },
};

// -------- intake_pdfs (28.5 finalize enqueues a 'pending' row) --------

export const intakePdfsRepo = {
  async insertPending(
    sessionId: string,
    sourceFileIds: string[],
    trx?: Knex.Transaction,
  ): Promise<void> {
    // ON CONFLICT (session_id) DO NOTHING so finalize is idempotent —
    // re-finalizing a session doesn't create a second pending row. The
    // 28.9 ticker picks up the existing one and retries.
    await (trx ?? db).raw(
      `INSERT INTO intake_pdfs (session_id, source_file_ids, conversion_status)
         VALUES (?, ?::uuid[], 'pending')
         ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, sourceFileIds],
    );
  },
};

// -------- intake_notifications_outbox (28.5 finalize enqueues rows) --------

export const intakeNotificationsRepo = {
  /**
   * Enqueue one notification row. The 28.10 / 28.12 tickers claim rows
   * with `status='pending'` and `next_attempt_at <= now()` and run them
   * through the email / SMS / in-app fanout.
   */
  async enqueue(
    row: {
      session_id: string | null;
      channel: IntakeNotificationChannel;
      recipient_hash: string;
      template_id: string;
      payload: Record<string, unknown>;
    },
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx ?? db)('intake_notifications_outbox').insert({
      session_id: row.session_id,
      channel: row.channel,
      recipient_hash: row.recipient_hash,
      template_id: row.template_id,
      payload: JSON.stringify(row.payload) as unknown as never,
      status: 'pending',
    });
  },
};
