import type { ConversationType } from '@vibe-connect/shared-types';
import type { Knex } from 'knex';
import { db } from '../db/knex.js';

export interface ConversationRow {
  id: string;
  type: ConversationType;
  parent_conversation_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMemberRow {
  id: string;
  conversation_id: string;
  user_id: string | null;
  external_identity_id: string | null;
  joined_at: string;
  last_read_message_id: string | null;
  muted_until: string | null;
  removed_at: string | null;
}

export interface ConversationKeyRow {
  id: string;
  conversation_id: string;
  rotation_version: number;
  wrapped_keys: Record<string, string>;
  created_at: string;
}

export const conversationsRepo = {
  create(
    type: ConversationType,
    opts: { parentConversationId?: string | null; displayName?: string | null } = {},
    trx?: Knex.Transaction,
  ) {
    const q = (trx ?? db)<ConversationRow>('conversations')
      .insert({
        type,
        parent_conversation_id: opts.parentConversationId ?? null,
        display_name: opts.displayName ?? null,
      })
      .returning('*');
    return q.then((rows) => rows[0]!);
  },
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ConversationRow>('conversations').where({ id }).first();
  },
  touchUpdated(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ConversationRow>('conversations')
      .where({ id })
      .update({ updated_at: db.fn.now() });
  },
  async listForUser(userId: string) {
    // Joins live in a raw query for clarity; returns the minimal payload the UI needs.
    const rows = await db.raw(
      `
      WITH my_convs AS (
        SELECT cm.conversation_id
        FROM conversation_members cm
        WHERE cm.user_id = ?
          AND cm.removed_at IS NULL
      ),
      last_msgs AS (
        SELECT DISTINCT ON (m.conversation_id) m.conversation_id,
               m.id AS last_message_id,
               m.ciphertext AS last_ciphertext,
               m.content_key_version AS last_content_key_version,
               m.created_at AS last_message_at
        FROM messages m
        WHERE m.conversation_id IN (SELECT conversation_id FROM my_convs)
          AND m.deleted_at IS NULL
          AND (m.scheduled_for IS NULL OR m.scheduled_for <= NOW())
        ORDER BY m.conversation_id, m.created_at DESC
      ),
      unread AS (
        SELECT cm.conversation_id,
               COUNT(m.id) FILTER (
                 WHERE cm.last_read_message_id IS NULL
                    OR m.created_at > COALESCE(
                      (SELECT created_at FROM messages WHERE id = cm.last_read_message_id),
                      '1970-01-01'
                    )
               ) AS unread_count
        FROM conversation_members cm
        LEFT JOIN messages m ON m.conversation_id = cm.conversation_id
          AND m.deleted_at IS NULL
          AND (m.scheduled_for IS NULL OR m.scheduled_for <= NOW())
        WHERE cm.user_id = ? AND cm.removed_at IS NULL
        GROUP BY cm.conversation_id
      )
      SELECT c.id, c.type, c.parent_conversation_id, c.display_name, c.updated_at,
             lm.last_message_id, lm.last_ciphertext, lm.last_content_key_version, lm.last_message_at,
             COALESCE(u.unread_count, 0) AS unread_count,
             (
               SELECT ARRAY_AGG(cm2.user_id) FILTER (WHERE cm2.user_id IS NOT NULL)
               FROM conversation_members cm2
               WHERE cm2.conversation_id = c.id AND cm2.removed_at IS NULL
             ) AS member_user_ids,
             (
               SELECT ARRAY_AGG(cm3.external_identity_id) FILTER (WHERE cm3.external_identity_id IS NOT NULL)
               FROM conversation_members cm3
               WHERE cm3.conversation_id = c.id AND cm3.removed_at IS NULL
             ) AS member_external_identity_ids
      FROM conversations c
      LEFT JOIN last_msgs lm ON lm.conversation_id = c.id
      LEFT JOIN unread u ON u.conversation_id = c.id
      WHERE c.id IN (SELECT conversation_id FROM my_convs)
      ORDER BY COALESCE(lm.last_message_at, c.updated_at) DESC
      `,
      [userId, userId],
    );
    return rows.rows as Array<{
      id: string;
      type: ConversationType;
      parent_conversation_id: string | null;
      display_name: string | null;
      updated_at: string;
      last_message_id: string | null;
      last_ciphertext: Buffer | null;
      last_content_key_version: number | null;
      last_message_at: string | null;
      unread_count: string;
      member_user_ids: string[] | null;
      member_external_identity_ids: string[] | null;
    }>;
  },
};

export const conversationMembersRepo = {
  async currentForConversation(conversationId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ConversationMemberRow>('conversation_members')
      .where({ conversation_id: conversationId })
      .whereNull('removed_at');
  },
  async isMember(conversationId: string, userId: string, trx?: Knex.Transaction): Promise<boolean> {
    const row = await (trx ?? db)('conversation_members')
      .where({ conversation_id: conversationId, user_id: userId })
      .whereNull('removed_at')
      .first();
    return Boolean(row);
  },
  async addUser(conversationId: string, userId: string, trx?: Knex.Transaction) {
    await (trx ?? db)('conversation_members')
      .insert({ conversation_id: conversationId, user_id: userId })
      .onConflict()
      .ignore();
  },
  async addExternal(conversationId: string, externalIdentityId: string, trx?: Knex.Transaction) {
    await (trx ?? db)('conversation_members')
      .insert({ conversation_id: conversationId, external_identity_id: externalIdentityId })
      .onConflict()
      .ignore();
  },
  async removeUser(conversationId: string, userId: string, trx?: Knex.Transaction) {
    await (trx ?? db)('conversation_members')
      .where({ conversation_id: conversationId, user_id: userId })
      .whereNull('removed_at')
      .update({ removed_at: db.fn.now() });
  },
  async setLastRead(conversationId: string, userId: string, messageId: string) {
    await db('conversation_members')
      .where({ conversation_id: conversationId, user_id: userId })
      .whereNull('removed_at')
      .update({ last_read_message_id: messageId });
  },
};

export const conversationKeysRepo = {
  async latest(conversationId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ConversationKeyRow>('conversation_keys')
      .where({ conversation_id: conversationId })
      .orderBy('rotation_version', 'desc')
      .first();
  },
  async insert(
    conversationId: string,
    rotationVersion: number,
    wrappedKeys: Record<string, string>,
    trx?: Knex.Transaction,
  ) {
    const [row] = await (trx ?? db)<ConversationKeyRow>('conversation_keys')
      .insert({
        conversation_id: conversationId,
        rotation_version: rotationVersion,
        wrapped_keys: wrappedKeys,
      })
      .returning('*');
    return row!;
  },
  async updateWrapped(id: string, wrappedKeys: Record<string, string>, trx?: Knex.Transaction) {
    await (trx ?? db)('conversation_keys').where({ id }).update({ wrapped_keys: wrappedKeys });
  },
};
