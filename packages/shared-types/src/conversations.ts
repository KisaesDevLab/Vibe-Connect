import type { ExternalIdentityId, UserId } from './users.js';

export type ConversationId = string;
export type ConversationType = 'internal' | 'external' | 'internal_thread';

export interface ConversationSummary {
  id: ConversationId;
  type: ConversationType;
  parentConversationId: ConversationId | null;
  displayName: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreviewCiphertext: string | null;
  lastMessageContentKeyVersion: number | null;
  memberUserIds: UserId[];
  memberExternalIdentityIds: ExternalIdentityId[];
  hasInternalThread: boolean;
  internalThreadConversationId: ConversationId | null;
  updatedAt: string;
}

export interface ConversationMember {
  conversationId: ConversationId;
  userId: UserId | null;
  externalIdentityId: ExternalIdentityId | null;
  joinedAt: string;
  lastReadMessageId: string | null;
  mutedUntil: string | null;
}
