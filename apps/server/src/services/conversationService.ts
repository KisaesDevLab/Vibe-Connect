/**
 * Conversation lifecycle: creation, membership, per-device wrapped-key tracking.
 *
 * CRYPTO: the server never sees the raw conversation key. Clients upload the per-recipient
 * wrapped keys they generated locally; we just store them.
 */
import type { Knex } from 'knex';
import { db } from '../db/knex.js';
import {
  conversationKeysRepo,
  conversationMembersRepo,
  conversationsRepo,
} from '../repositories/conversations.js';
import { auditRepo } from '../repositories/audit.js';
import { logger } from '../logger.js';
import { publish } from '../realtime/pgFanout.js';

export interface CreateConversationInput {
  actorUserId: string;
  type: 'internal' | 'external' | 'internal_thread';
  parentConversationId?: string;
  memberUserIds: string[]; // must include the actor
  memberExternalIdentityIds?: string[];
  displayName?: string | null;
  /** per-recipient wrapped conversation key the client constructed via packages/crypto. */
  wrappedKeys: Record<string, string>;
  rotationVersion?: number;
}

export async function createConversation(input: CreateConversationInput): Promise<string> {
  if (!input.memberUserIds.includes(input.actorUserId)) {
    throw new Error('actor must be a member');
  }
  if (input.type === 'internal' && (input.memberExternalIdentityIds?.length ?? 0) > 0) {
    throw new Error('internal conversations cannot include external members');
  }
  if (input.type === 'internal_thread' && !input.parentConversationId) {
    throw new Error('internal_thread requires parent');
  }

  return db.transaction(async (trx) => {
    const conv = await conversationsRepo.create(
      input.type,
      {
        parentConversationId: input.parentConversationId ?? null,
        displayName: input.displayName ?? null,
      },
      trx,
    );
    for (const uid of input.memberUserIds) {
      await conversationMembersRepo.addUser(conv.id, uid, trx);
    }
    for (const eid of input.memberExternalIdentityIds ?? []) {
      await conversationMembersRepo.addExternal(conv.id, eid, trx);
    }
    await conversationKeysRepo.insert(conv.id, input.rotationVersion ?? 1, input.wrappedKeys, trx);
    await auditRepo.write({
      actorUserId: input.actorUserId,
      action: 'conversation.created',
      targetType: 'conversation',
      targetId: conv.id,
      details: {
        type: conv.type,
        memberUserCount: input.memberUserIds.length,
        memberExternalCount: (input.memberExternalIdentityIds ?? []).length,
      },
    });

    // Phase 24: External conversations get a mirrored internal_thread auto-created.
    // We build the shell here but the caller needs to upload its wrapped keys in a second
    // round-trip (see POST /conversations/:id/side-thread/keys).
    if (input.type === 'external') {
      const staffOnly = input.memberUserIds;
      const thread = await conversationsRepo.create(
        'internal_thread',
        {
          parentConversationId: conv.id,
        },
        trx,
      );
      for (const uid of staffOnly) {
        await conversationMembersRepo.addUser(thread.id, uid, trx);
      }
      logger.info('conversation.side_thread_shell_created', {
        parentId: conv.id,
        threadId: thread.id,
      });
    }

    return conv.id;
  });
}

async function propagateStaffMembershipToThread(
  parentId: string,
  userId: string,
  action: 'add' | 'remove',
  trx: Knex.Transaction,
): Promise<void> {
  const thread = await trx('conversations')
    .where({ parent_conversation_id: parentId, type: 'internal_thread' })
    .first();
  if (!thread) return;
  if (action === 'add') {
    await conversationMembersRepo.addUser(thread.id, userId, trx);
  } else {
    await conversationMembersRepo.removeUser(thread.id, userId, trx);
  }
}

export async function addMember(
  actorUserId: string,
  conversationId: string,
  opts: {
    userId?: string;
    externalIdentityId?: string;
    newWrappedKeys: Record<string, string>;
    rotationVersion: number;
  },
): Promise<void> {
  const conv = await conversationsRepo.byId(conversationId);
  if (!conv) throw new Error('not_found');
  // Phase 24: internal_thread cannot gain external members.
  if (conv.type === 'internal_thread' && opts.externalIdentityId) {
    throw new Error('external_forbidden_in_thread');
  }
  await db.transaction(async (trx) => {
    if (opts.userId) {
      await conversationMembersRepo.addUser(conversationId, opts.userId, trx);
      // Phase 24: staff propagate from parent external → thread.
      if (conv.type === 'external') {
        await propagateStaffMembershipToThread(conversationId, opts.userId, 'add', trx);
      }
    }
    if (opts.externalIdentityId) {
      await conversationMembersRepo.addExternal(conversationId, opts.externalIdentityId, trx);
    }
    await conversationKeysRepo.insert(
      conversationId,
      opts.rotationVersion,
      opts.newWrappedKeys,
      trx,
    );
    await auditRepo.write({
      actorUserId,
      action: 'conversation.member_added',
      targetType: 'conversation',
      targetId: conversationId,
      details: { userId: opts.userId ?? null, externalIdentityId: opts.externalIdentityId ?? null },
    });
  });
  await publish({
    type: 'conversation:rekey',
    conversationId,
    rotationVersion: opts.rotationVersion,
  });
}

export async function removeMember(
  actorUserId: string,
  conversationId: string,
  opts: {
    userId?: string;
    externalIdentityId?: string;
    rotatedWrappedKeys: Record<string, string>;
    rotationVersion: number;
  },
): Promise<void> {
  const parentConv = await conversationsRepo.byId(conversationId);
  await db.transaction(async (trx) => {
    if (opts.userId) {
      await conversationMembersRepo.removeUser(conversationId, opts.userId, trx);
      if (parentConv?.type === 'external') {
        await propagateStaffMembershipToThread(conversationId, opts.userId, 'remove', trx);
      }
    }
    if (opts.externalIdentityId) {
      await (trx ?? db)('conversation_members')
        .where({ conversation_id: conversationId, external_identity_id: opts.externalIdentityId })
        .whereNull('removed_at')
        .update({ removed_at: db.fn.now() });
    }
    await conversationKeysRepo.insert(
      conversationId,
      opts.rotationVersion,
      opts.rotatedWrappedKeys,
      trx,
    );
    await auditRepo.write({
      actorUserId,
      action: 'conversation.member_removed',
      targetType: 'conversation',
      targetId: conversationId,
      details: { userId: opts.userId ?? null, externalIdentityId: opts.externalIdentityId ?? null },
    });
  });
  await publish({
    type: 'conversation:rekey',
    conversationId,
    rotationVersion: opts.rotationVersion,
  });
}

export class NotAMemberError extends Error {
  readonly status = 403;
  readonly code = 'not_a_member';
  constructor() {
    super('not a member of this conversation');
    this.name = 'NotAMemberError';
  }
}

export async function assertCallerIsMember(
  conversationId: string,
  userId: string,
  trx?: Knex.Transaction,
): Promise<void> {
  const ok = await conversationMembersRepo.isMember(conversationId, userId, trx);
  if (!ok) throw new NotAMemberError();
}
