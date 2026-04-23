import type { ConversationId } from './conversations.js';
import type { ExternalIdentityId, UserId } from './users.js';

export type MessageId = string;
export type MessageSource = 'app' | 'email-in' | 'sms-in' | 'system';

export interface Attachment {
  id: string;
  messageId: MessageId;
  filenameCiphertext: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  wrappedFileKey: string;
  createdAt: string;
}

export interface EncryptedMessage {
  id: MessageId;
  conversationId: ConversationId;
  senderId: UserId | null;
  senderExternalIdentityId: ExternalIdentityId | null;
  ciphertext: string; // base64
  contentKeyVersion: number;
  urgent: boolean;
  scheduledFor: string | null;
  source: MessageSource;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: Attachment[];
}

export interface DecryptedMessage {
  id: MessageId;
  conversationId: ConversationId;
  senderId: UserId | null;
  senderExternalIdentityId: ExternalIdentityId | null;
  body: string;
  urgent: boolean;
  scheduledFor: string | null;
  source: MessageSource;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  attachments: DecryptedAttachmentMeta[];
}

export interface DecryptedAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ReadReceipt {
  messageId: MessageId;
  userId: UserId | null;
  externalIdentityId: ExternalIdentityId | null;
  readAt: string;
}
