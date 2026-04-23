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
  ciphertext_meta: Record<string, unknown>;
  source_meta: Record<string, unknown>;
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
      })
      .returning('*');
    return row!;
  },

  async list(
    conversationId: string,
    opts: { beforeId?: string; limit?: number } = {},
  ): Promise<MessageRow[]> {
    let q = db<MessageRow>('messages')
      .where({ conversation_id: conversationId })
      .whereNull('deleted_at')
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

  async edit(id: string, ciphertext: Buffer, ciphertextMeta: Record<string, unknown>) {
    const [row] = await db<MessageRow>('messages')
      .where({ id })
      .update({
        ciphertext,
        ciphertext_meta: ciphertextMeta,
        edited_at: db.fn.now(),
      })
      .returning('*');
    return row;
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
};

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename_ciphertext: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  wrapped_file_key: Buffer;
  scan_status: 'pending' | 'clean' | 'infected';
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
