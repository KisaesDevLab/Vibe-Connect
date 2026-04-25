import type { MessageSource } from '@vibe-connect/shared-types';
import type { Knex } from 'knex';
import { db } from '../db/knex.js';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  sender_external_identity_id: string | null;
  ciphertext: Buffer;
  content_key_version: number;
  urgent: boolean;
  scheduled_for: string | null;
  source: MessageSource;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  destruct_after_view_seconds: number | null;
  destruct_at: string | null;
  ciphertext_meta: Record<string, unknown>;
  source_meta: Record<string, unknown>;
}

export interface MessageEditRow {
  id: string;
  message_id: string;
  ciphertext: Buffer;
  ciphertext_meta: Record<string, unknown>;
  content_key_version: number;
  replaced_at: string;
  replaced_by_user_id: string | null;
}

export interface InsertMessageInput {
  conversationId: string;
  senderId?: string | null;
  senderExternalIdentityId?: string | null;
  ciphertext: Buffer;
  contentKeyVersion: number;
  urgent?: boolean;
  scheduledFor?: Date | string | null;
  source?: MessageSource;
  ciphertextMeta?: Record<string, unknown>;
  sourceMeta?: Record<string, unknown>;
  /** Phase 27: optional self-destruct after the first non-sender read. */
  destructAfterViewSeconds?: number | null;
}

export const messagesRepo = {
  async insert(input: InsertMessageInput, trx?: Knex.Transaction): Promise<MessageRow> {
    const [row] = await (trx ?? db)<MessageRow>('messages')
      .insert({
        conversation_id: input.conversationId,
        sender_id: input.senderId ?? null,
        sender_external_identity_id: input.senderExternalIdentityId ?? null,
        ciphertext: input.ciphertext,
        content_key_version: input.contentKeyVersion,
        urgent: input.urgent ?? false,
        scheduled_for:
          input.scheduledFor instanceof Date
            ? input.scheduledFor.toISOString()
            : (input.scheduledFor ?? null),
        source: input.source ?? 'app',
        ciphertext_meta: input.ciphertextMeta ?? {},
        source_meta: input.sourceMeta ?? {},
        destruct_after_view_seconds: input.destructAfterViewSeconds ?? null,
      })
      .returning('*');
    return row!;
  },

  /**
   * Lists messages in a conversation. Deleted rows ARE included so the UI can
   * render a "Message deleted" placeholder — the route handler is responsible
   * for stripping the ciphertext + attachments for those rows. Pre-Phase-27
   * this filtered out deleted rows entirely; the new client expects to see the
   * tombstone so it can replace its own optimistic copy with the placeholder.
   */
  async list(
    conversationId: string,
    opts: { beforeId?: string; limit?: number } = {},
  ): Promise<MessageRow[]> {
    let q = db<MessageRow>('messages')
      .where({ conversation_id: conversationId })
      .where((b) => b.whereNull('scheduled_for').orWhere('scheduled_for', '<=', db.fn.now()))
      .orderBy('created_at', 'desc')
      .limit(opts.limit ?? 50);
    if (opts.beforeId) {
      const cursor = await db<MessageRow>('messages').where({ id: opts.beforeId }).first();
      if (cursor) q = q.where('created_at', '<', cursor.created_at);
    }
    return q;
  },

  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<MessageRow>('messages').where({ id }).first();
  },

  /**
   * Phase 27: edit is now a transaction that snapshots the prior ciphertext
   * into `message_edits` BEFORE overwriting the live row. The snapshot
   * carries `content_key_version` so a key rotation between edits doesn't
   * leave history rows undecryptable. `replacedByUserId` is the staffer who
   * saved the new version (admin history view shows it).
   */
  async edit(
    id: string,
    ciphertext: Buffer,
    ciphertextMeta: Record<string, unknown>,
    replacedByUserId: string,
  ) {
    return db.transaction(async (trx) => {
      const prior = await trx<MessageRow>('messages').where({ id }).first();
      if (!prior) return undefined;
      await trx<MessageEditRow>('message_edits').insert({
        message_id: id,
        ciphertext: prior.ciphertext,
        ciphertext_meta: prior.ciphertext_meta,
        content_key_version: prior.content_key_version,
        replaced_by_user_id: replacedByUserId,
      });
      const [row] = await trx<MessageRow>('messages')
        .where({ id })
        .update({
          ciphertext,
          ciphertext_meta: ciphertextMeta,
          edited_at: trx.fn.now(),
        })
        .returning('*');
      return row;
    });
  },

  async softDelete(id: string) {
    await db<MessageRow>('messages').where({ id }).update({
      deleted_at: db.fn.now(),
    });
  },

  async cryptoShred(id: string) {
    // Retention: wipe the ciphertext bytes. Without the key we couldn't read the row anyway,
    // but zeroing the ciphertext makes the shredding explicit and visible to operators.
    await db<MessageRow>('messages')
      .where({ id })
      .update({ ciphertext: Buffer.alloc(0), ciphertext_meta: {} });
  },

  /**
   * Phase 27: stamp `destruct_at` when a non-sender recipient marks the
   * message read. Sender self-reads are skipped so a staffer hovering their
   * own message doesn't start the timer. Idempotent — `WHERE destruct_at IS
   * NULL` guarantees a second concurrent read is a no-op. Returns the row
   * count actually updated (0 or 1) so callers can decide whether to write
   * the `message.destruct_armed` audit row.
   *
   * `readerUserId` may be null when the reader is an external identity
   * (portal); in that case the row's `sender_id` is necessarily a staff user
   * (clients can only post via `sender_external_identity_id`), so the
   * non-sender check is automatically satisfied.
   */
  async stampDestructAt(
    messageId: string,
    fireAt: Date,
    readerUserId: string | null,
  ): Promise<number> {
    let q = db<MessageRow>('messages')
      .where({ id: messageId })
      .whereNotNull('destruct_after_view_seconds')
      .whereNull('destruct_at')
      .whereNull('deleted_at');
    if (readerUserId !== null) {
      // sender_id IS NULL OR sender_id <> readerUserId — i.e. anyone except
      // the message's own sender starts the timer.
      q = q.andWhere((b) =>
        b.whereNull('sender_id').orWhere('sender_id', '<>', readerUserId),
      );
    }
    return q.update({ destruct_at: fireAt.toISOString() });
  },
};

/**
 * Envelope format discriminator. Two shapes share the attachments columns:
 *   - 'conversation-key-v1': filename_ciphertext = secretbox(convKey, name);
 *     wrapped_file_key = secretbox(convKey, fileKey). Readable by any
 *     conversation member with the current conversation key.
 *   - 'bridge-sealed-v1': filename_ciphertext = firm-key-sealed envelope
 *     (bridge inbound); wrapped_file_key empty. Requires a staff-side
 *     rewrap pass before any client can open it.
 */
export type AttachmentEnvelopeFormat = 'conversation-key-v1' | 'bridge-sealed-v1';

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename_ciphertext: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  wrapped_file_key: Buffer;
  scan_status: 'pending' | 'clean' | 'infected';
  envelope_format: AttachmentEnvelopeFormat;
  created_at: string;
}

export const attachmentsRepo = {
  async insert(row: Omit<AttachmentRow, 'id' | 'created_at'>) {
    const [inserted] = await db<AttachmentRow>('attachments').insert(row).returning('*');
    return inserted!;
  },
  byMessage(messageId: string) {
    return db<AttachmentRow>('attachments').where({ message_id: messageId });
  },
  byId(id: string) {
    return db<AttachmentRow>('attachments').where({ id }).first();
  },
  updateScanStatus(id: string, status: 'clean' | 'infected') {
    return db<AttachmentRow>('attachments').where({ id }).update({ scan_status: status });
  },
  delete(id: string) {
    return db<AttachmentRow>('attachments').where({ id }).delete();
  },
};

/**
 * Phase 27: history of pre-edit message ciphertexts. Populated transactionally
 * by `messagesRepo.edit()`. Used by the admin history-viewer route to walk
 * the timeline of edits for a single message; recipient-facing routes never
 * touch this table.
 */
export const messageEditsRepo = {
  listForMessage(messageId: string): Promise<MessageEditRow[]> {
    return db<MessageEditRow>('message_edits')
      .where({ message_id: messageId })
      .orderBy('replaced_at', 'asc');
  },
};

export const readReceiptsRepo = {
  async markRead(messageId: string, userId: string) {
    // NOTE: our unique indexes are partial (WHERE user_id IS NOT NULL etc.) which means
    // ON CONFLICT with a column target doesn't match. We fall back to query-then-insert.
    const existing = await db('read_receipts')
      .where({ message_id: messageId, user_id: userId })
      .first();
    if (existing) return;
    await db('read_receipts').insert({ message_id: messageId, user_id: userId });
  },
  async markReadExternal(messageId: string, externalIdentityId: string) {
    const existing = await db('read_receipts')
      .where({ message_id: messageId, external_identity_id: externalIdentityId })
      .first();
    if (existing) return;
    await db('read_receipts').insert({
      message_id: messageId,
      external_identity_id: externalIdentityId,
    });
  },
  listForMessage(messageId: string) {
    return db('read_receipts').where({ message_id: messageId });
  },
};
