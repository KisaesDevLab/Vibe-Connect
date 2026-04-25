// Phase 24: Client Requests & Document Collection — shared API shapes.
//
// Crypto-split summary (see vibe-connect-build-plan.md / Phase 24 plan):
//   - List title/description: cleartext on the wire (and at rest) so the
//     server can render the portal Requests tab pre-unwrap and template
//     nudge bodies.
//   - Item title/description/revision_note: ciphertext (base64-encoded
//     bytea) wrapped under the conversation's content key — same envelope
//     primitive used for message bodies. Clients decrypt locally.
//
// `requestItemId` linkage on a message rides the existing
// `messages.ciphertext_meta` JSONB blob; no new column. Reserved keys on
// that blob (don't collide):
//   - requestItemId         : string (uuid)
//   - requestListId         : string (uuid)
//   - systemEventType       : 'request_item_revision' | 'request_nudge_sent' | …
//   - revisionNoteCiphertext: string (base64)  — used by system messages
//                              that announce a revision so the client can
//                              decrypt the note inline without an extra
//                              fetch. Capped at the boundedMeta 4 KB
//                              ceiling.
import type { ConversationId, UserId } from './index.js';

export type RequestListId = string;
export type RequestItemId = string;
export type RequestTemplateId = string;

export type RequestListStatus = 'active' | 'completed' | 'archived' | 'cancelled';
export type RequestItemStatus = 'pending' | 'submitted' | 'done' | 'revision';
export type RequestResponseType = 'file' | 'text' | 'both';

export type RequestSystemEventType =
  | 'request_list_created'
  | 'request_item_revision'
  | 'request_item_done'
  | 'request_nudge_sent';

export interface RequestList {
  id: RequestListId;
  conversationId: ConversationId;
  title: string;
  description: string | null;
  dueDate: string | null; // ISO date (YYYY-MM-DD)
  status: RequestListStatus;
  /** Null when the original creator's user row was deleted (ON DELETE SET NULL).
   *  Audit log retains the original actor on the matching `request.list_created` row. */
  createdBy: UserId | null;
  templateId: RequestTemplateId | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RequestItem {
  id: RequestItemId;
  listId: RequestListId;
  /** base64-encoded ciphertext of the staff-authored item title. */
  titleCiphertext: string;
  /** base64-encoded ciphertext; null when the staff didn't add a description. */
  descriptionCiphertext: string | null;
  /**
   * base64-encoded ciphertext of the latest revision note from staff.
   * Cleared on transition back to `pending`/`submitted`/`done`.
   */
  revisionNoteCiphertext: string | null;
  contentKeyVersion: number;
  responseType: RequestResponseType;
  status: RequestItemStatus;
  sortOrder: number;
  dueDate: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  completedBy: UserId | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestListWithItems extends RequestList {
  items: RequestItem[];
}

export interface RequestTemplate {
  id: RequestTemplateId;
  name: string;
  description: string | null;
  itemSpecs: RequestTemplateItemSpec[];
  /** Null when the creator's user row was deleted (ON DELETE SET NULL). */
  createdBy: UserId | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/**
 * Cleartext template item — these are firm-internal config, not E2EE. When
 * staff applies a template to a conversation, the staff client encrypts each
 * `title`/`description` under the conversation's content key before POSTing
 * the resulting items.
 */
export interface RequestTemplateItemSpec {
  title: string;
  description?: string | null;
  responseType: RequestResponseType;
  sortOrder: number;
  defaultDueOffsetDays?: number | null;
}

// ---------------- Request bodies ----------------

export interface CreateRequestListBody {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  templateId?: RequestTemplateId | null;
  /**
   * When provided, items are inserted atomically with the list. For the
   * template-apply flow, the staff client expands the template's specs and
   * encrypts each title/description here.
   */
  items?: CreateRequestItemBody[];
}

export interface CreateRequestItemBody {
  titleCiphertext: string; // base64
  descriptionCiphertext?: string | null; // base64
  contentKeyVersion: number;
  responseType: RequestResponseType;
  sortOrder?: number;
  dueDate?: string | null;
}

export interface PatchRequestListBody {
  title?: string;
  description?: string | null;
  dueDate?: string | null;
  status?: RequestListStatus;
}

export interface PatchRequestItemBody {
  titleCiphertext?: string;
  descriptionCiphertext?: string | null;
  contentKeyVersion?: number;
  responseType?: RequestResponseType;
  sortOrder?: number;
  dueDate?: string | null;
}

export interface RequestRevisionBody {
  noteCiphertext: string; // base64
  contentKeyVersion: number;
}

export interface LinkMessageBody {
  messageId: string;
}

export interface NudgeBody {
  /** ISO timestamp; omit for "send now". */
  sendAt?: string;
  /** Channel hint — actual delivery still respects each recipient's prefs. */
  channel: 'inapp' | 'email' | 'sms' | 'all';
  /** Optional staff-authored override of the default nudge body. ≤500 chars. */
  customBody?: string;
}

export interface CreateRequestTemplateBody {
  name: string;
  description?: string | null;
  itemSpecs: RequestTemplateItemSpec[];
}

export interface PatchRequestTemplateBody {
  name?: string;
  description?: string | null;
  itemSpecs?: RequestTemplateItemSpec[];
}

// ---------------- Response shapes ----------------

export interface RequestListsResponse {
  lists: RequestList[];
}

export interface RequestListResponse {
  list: RequestListWithItems;
}

export interface RequestTemplatesResponse {
  templates: RequestTemplate[];
}

export interface RequestDashboardRow {
  list: RequestList;
  conversationDisplayName: string | null;
  itemCounts: { pending: number; submitted: number; done: number; revision: number };
  lastActivityAt: string | null;
}

export interface RequestDashboardResponse {
  rows: RequestDashboardRow[];
}
