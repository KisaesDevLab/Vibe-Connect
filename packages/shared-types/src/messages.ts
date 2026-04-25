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
  scanStatus: 'pending' | 'clean' | 'infected';
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
  /** Phase 27: optional self-destruct timer (seconds after first non-sender read). */
  destructAfterViewSeconds?: number | null;
  /** Phase 27: ISO timestamp at which the destruct ticker will soft-delete the row. */
  destructAt?: string | null;
  ciphertextMeta: Record<string, unknown> | null;
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
  destructAfterViewSeconds?: number | null;
  destructAt?: string | null;
  attachments: DecryptedAttachmentMeta[];
}

export interface DecryptedAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Base64 secretbox wrap of the file key under the conversation key. */
  wrappedFileKey: string;
  /** Envelope version / content-key-version the file was encrypted with. */
  contentKeyVersion: number;
  scanStatus: 'pending' | 'clean' | 'infected';
}

export interface ReadReceipt {
  messageId: MessageId;
  userId: UserId | null;
  externalIdentityId: ExternalIdentityId | null;
  readAt: string;
}
