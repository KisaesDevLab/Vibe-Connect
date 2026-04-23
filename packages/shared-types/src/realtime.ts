import type { ConversationId } from './conversations.js';
import type { EncryptedMessage, MessageId } from './messages.js';
import type { UserId, UserStatus } from './users.js';

export interface ServerToClientEvents {
  'message:new': (msg: EncryptedMessage) => void;
  'message:edit': (msg: EncryptedMessage) => void;
  'message:delete': (payload: { messageId: MessageId; conversationId: ConversationId }) => void;
  'message:read': (payload: {
    messageId: MessageId;
    conversationId: ConversationId;
    userId: UserId | null;
    externalIdentityId: string | null;
    readAt: string;
  }) => void;
  'presence:update': (payload: { userId: UserId; status: UserStatus; lastSeenAt: string }) => void;
  'typing:start': (payload: { conversationId: ConversationId; userId: UserId }) => void;
  'typing:stop': (payload: { conversationId: ConversationId; userId: UserId }) => void;
  'conversation:rekey': (payload: {
    conversationId: ConversationId;
    rotationVersion: number;
  }) => void;
  'device:revoked': (payload: { deviceId: string }) => void;
}

export interface ClientToServerEvents {
  'conversation:join': (conversationId: ConversationId) => void;
  'conversation:leave': (conversationId: ConversationId) => void;
  'typing:start': (conversationId: ConversationId) => void;
  'typing:stop': (conversationId: ConversationId) => void;
  'presence:ping': () => void;
}
