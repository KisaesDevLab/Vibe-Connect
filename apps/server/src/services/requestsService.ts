// Phase 24: Client Requests & Document Collection — service layer.
//
// Pure-ish business logic on top of the request_lists / request_items /
// request_templates repositories. No HTTP and no realtime publishes here —
// the route layer (24.2) is responsible for translating ServiceResult
// objects into 200/400 responses and emitting `request:changed` events.
// Keeping the publishes outside lets unit tests exercise the state machine
// against the real DB without needing the socket harness running.
//
// Every state transition writes an audit_log row via auditRepo.write().
import type { Knex } from 'knex';
import { z } from 'zod';
import type {
  CreateRequestItemBody,
  CreateRequestListBody,
  CreateRequestTemplateBody,
  PatchRequestItemBody,
  PatchRequestListBody,
  PatchRequestTemplateBody,
  RequestItem,
  RequestList,
  RequestListWithItems,
  RequestTemplate,
  RequestTemplateItemSpec,
} from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';
import { auditRepo } from '../repositories/audit.js';
import { conversationMembersRepo } from '../repositories/conversations.js';
import {
  requestItemsRepo,
  requestListsRepo,
  requestTemplatesRepo,
  type RequestItemRow,
  type RequestListRow,
  type RequestTemplateRow,
} from '../repositories/requests.js';

// ---------- Zod schemas (shared with the route layer in 24.2) ----------

const itemSpecSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  responseType: z.enum(['file', 'text', 'both']),
  sortOrder: z.number().int().min(0).default(0),
  defaultDueOffsetDays: z.number().int().min(0).max(3650).nullable().optional(),
});

export const requestTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  itemSpecs: z.array(itemSpecSchema).min(1).max(100),
});

export const requestTemplatePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  itemSpecs: z.array(itemSpecSchema).min(1).max(100).optional(),
});

const responseTypeSchema = z.enum(['file', 'text', 'both']);
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .nullable()
  .optional();

// Each ciphertext field is base64; capped to keep the JSON body honest.
// 64 KiB ciphertext is well above any realistic per-item title or description.
// RFC-4648 form: groups of 4 chars, with 0–2 trailing `=` for padding.
const B64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
const b64Ciphertext = z.string().min(1).max(65536).regex(B64_REGEX, 'must be RFC4648 base64');

// The revision-note ciphertext is echoed onto a system message's
// `ciphertext_meta` JSONB blob, which is hard-capped at 4 KiB by
// `boundedMeta` in routes/conversations.ts. Tighten this field's cap to
// ~3 KiB so the wrapping JSON keys (`systemEventType`, `requestItemId`,
// `requestListId`) still fit under that ceiling. The matching ITEM row's
// `revision_note_ciphertext` bytea column is uncapped — staff can store
// longer notes there if they're patched directly via PATCH /request-items
// without the system-message echo, but `request_revision` route caps both
// to keep the JSONB ceiling honest.
const b64NoteCiphertext = z.string().min(1).max(3072).regex(B64_REGEX, 'must be RFC4648 base64');

const createItemSchema = z.object({
  titleCiphertext: b64Ciphertext,
  descriptionCiphertext: b64Ciphertext.nullable().optional(),
  contentKeyVersion: z.number().int().min(1),
  responseType: responseTypeSchema,
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  dueDate: isoDateSchema,
});

export const createListSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  dueDate: isoDateSchema,
  templateId: z.string().uuid().nullable().optional(),
  items: z.array(createItemSchema).max(100).optional(),
});

export const patchListSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  dueDate: isoDateSchema,
  status: z.enum(['active', 'completed', 'archived', 'cancelled']).optional(),
});

export const addItemSchema = createItemSchema;

export const patchItemSchema = z.object({
  titleCiphertext: b64Ciphertext.optional(),
  descriptionCiphertext: b64Ciphertext.nullable().optional(),
  contentKeyVersion: z.number().int().min(1).optional(),
  responseType: responseTypeSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  dueDate: isoDateSchema,
});

export const requestRevisionSchema = z.object({
  // Capped at 3 KiB so the system-message echo into ciphertext_meta stays
  // under the 4 KiB JSONB ceiling enforced by `boundedMeta`.
  noteCiphertext: b64NoteCiphertext,
  contentKeyVersion: z.number().int().min(1),
});

export const linkMessageSchema = z.object({ messageId: z.string().uuid() });

// ---------- Errors ----------

export type ServiceErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'bad_state'
  | 'wrong_conversation'
  | 'template_archived'
  | 'item_pending_only'
  | 'unique_violation';

export class RequestsServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ServiceErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

// ---------- Presenters ----------

/**
 * Postgres `date` columns come back from node-postgres as either ISO strings
 * (`'2026-04-30'`) or `Date` objects depending on the driver version + how
 * the value was inserted. The API contract is YYYY-MM-DD; coerce here so
 * downstream consumers don't have to care about the source format.
 */
function isoDateOrNull(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const yyyy = v.getUTCFullYear();
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(v.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // Already a string — strip any time portion just in case.
  return v.length >= 10 ? v.slice(0, 10) : v;
}

export function presentList(row: RequestListRow): RequestList {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    description: row.description,
    dueDate: isoDateOrNull(row.due_date),
    status: row.status,
    createdBy: row.created_by,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function presentItem(row: RequestItemRow): RequestItem {
  return {
    id: row.id,
    listId: row.list_id,
    titleCiphertext: row.title_ciphertext.toString('base64'),
    descriptionCiphertext: row.description_ciphertext
      ? row.description_ciphertext.toString('base64')
      : null,
    revisionNoteCiphertext: row.revision_note_ciphertext
      ? row.revision_note_ciphertext.toString('base64')
      : null,
    contentKeyVersion: row.content_key_version,
    responseType: row.response_type,
    status: row.status,
    sortOrder: row.sort_order,
    dueDate: isoDateOrNull(row.due_date),
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function presentTemplate(row: RequestTemplateRow): RequestTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    itemSpecs: (row.item_specs as RequestTemplateItemSpec[]) ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

// ---------- Authz helpers ----------

async function assertStaffMember(
  conversationId: string,
  userId: string,
  trx?: Knex.Transaction,
): Promise<void> {
  const ok = await conversationMembersRepo.isMember(conversationId, userId, trx);
  if (!ok) throw new RequestsServiceError('forbidden', 'not_a_conversation_member');
}

async function loadListOr404(listId: string, trx?: Knex.Transaction): Promise<RequestListRow> {
  const row = await requestListsRepo.byId(listId, trx);
  if (!row) throw new RequestsServiceError('not_found', 'list_not_found');
  return row;
}

async function loadItemOr404(itemId: string, trx?: Knex.Transaction): Promise<RequestItemRow> {
  const row = await requestItemsRepo.byId(itemId, trx);
  if (!row) throw new RequestsServiceError('not_found', 'item_not_found');
  return row;
}

async function loadItemAndListOr404(
  itemId: string,
  trx?: Knex.Transaction,
): Promise<{ item: RequestItemRow; list: RequestListRow }> {
  const item = await loadItemOr404(itemId, trx);
  const list = await loadListOr404(item.list_id, trx);
  return { item, list };
}

/**
 * Phase 24 follow-up: validate that a client-supplied `contentKeyVersion`
 * actually exists in `conversation_keys` for the given conversation. Without
 * this, a malicious or buggy client can write items at version numbers no
 * one's wrapped a key for, leaving the rows permanently unreadable. The
 * single indexed lookup on `(conversation_id, rotation_version)` is cheap.
 */
async function assertValidContentKeyVersion(
  conversationId: string,
  contentKeyVersion: number,
  trx: Knex.Transaction,
): Promise<void> {
  const exists = await trx('conversation_keys')
    .where({ conversation_id: conversationId, rotation_version: contentKeyVersion })
    .first('id');
  if (!exists) {
    throw new RequestsServiceError('bad_state', 'unknown_content_key_version', {
      conversationId,
      contentKeyVersion,
    });
  }
}

// ---------- Operations ----------

// Per-conversation / per-list ceilings to keep the surface bounded. A typical
// firm has ≤5 active engagements per conversation and ≤30 items per list;
// these caps absorb 10× headroom while preventing a runaway client (or buggy
// staff workflow) from creating thousands of rows.
const MAX_ACTIVE_LISTS_PER_CONVERSATION = 50;
const MAX_ITEMS_PER_LIST = 500;

export interface CreateListInput extends CreateRequestListBody {
  conversationId: string;
  createdBy: string;
}

/**
 * Creates a list and (optionally) seeds it with items, atomically. Items can
 * come either from `body.items` (preferred — already encrypted by the staff
 * client) or via expansion of `body.templateId` plus a parallel `items` array
 * the client encrypted from the template's item_specs. Server never encrypts
 * item titles itself; if both `templateId` and `items` are present, `items`
 * wins and `templateId` is recorded as provenance only.
 */
export async function createList(input: CreateListInput): Promise<RequestListWithItems> {
  return db.transaction(async (trx) => {
    await assertStaffMember(input.conversationId, input.createdBy, trx);

    // Per-conversation cap on active lists.
    const activeLists = await trx('request_lists')
      .where({ conversation_id: input.conversationId, status: 'active' })
      .count<{ count: string }[]>('* as count')
      .first();
    if (Number(activeLists?.count ?? 0) >= MAX_ACTIVE_LISTS_PER_CONVERSATION) {
      throw new RequestsServiceError('bad_state', 'list_cap_reached', {
        cap: MAX_ACTIVE_LISTS_PER_CONVERSATION,
      });
    }

    let templateId: string | null = null;
    if (input.templateId) {
      const template = await requestTemplatesRepo.byId(input.templateId, trx);
      if (!template) throw new RequestsServiceError('not_found', 'template_not_found');
      if (template.archived_at) {
        throw new RequestsServiceError('template_archived', 'template_archived');
      }
      templateId = template.id;
    }

    const listRow = await requestListsRepo.insert(
      {
        conversation_id: input.conversationId,
        title: input.title,
        description: input.description ?? null,
        due_date: input.dueDate ?? null,
        status: 'active',
        created_by: input.createdBy,
        template_id: templateId,
      },
      trx,
    );

    const itemRows: RequestItemRow[] = [];
    if (input.items && input.items.length > 0) {
      // Validate every distinct contentKeyVersion against conversation_keys
      // before the inserts — fail-fast keeps half-inserted lists from
      // appearing if the second item has a bogus version.
      const versions = Array.from(new Set(input.items.map((i) => i.contentKeyVersion)));
      for (const v of versions) await assertValidContentKeyVersion(input.conversationId, v, trx);
      for (const [i, spec] of input.items.entries()) {
        const item = await insertItemRow(listRow.id, spec, i, trx);
        itemRows.push(item);
      }
    }

    await auditRepo.write({
      actorUserId: input.createdBy,
      action: 'request.list_created',
      targetType: 'request_list',
      targetId: listRow.id,
      details: {
        conversationId: input.conversationId,
        itemCount: itemRows.length,
        templateId,
      },
    });

    return { ...presentList(listRow), items: itemRows.map(presentItem) };
  });
}

export async function listForConversation(
  conversationId: string,
  actorUserId: string,
): Promise<RequestList[]> {
  await assertStaffMember(conversationId, actorUserId);
  const rows = await requestListsRepo.listByConversation(conversationId);
  return rows.map(presentList);
}

export async function getListWithItems(
  listId: string,
  actorUserId: string,
): Promise<RequestListWithItems> {
  const list = await loadListOr404(listId);
  await assertStaffMember(list.conversation_id, actorUserId);
  const items = await requestItemsRepo.listByListId(list.id);
  return { ...presentList(list), items: items.map(presentItem) };
}

export async function updateList(
  listId: string,
  body: PatchRequestListBody,
  actorUserId: string,
): Promise<RequestList> {
  return db.transaction(async (trx) => {
    const list = await loadListOr404(listId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);

    const patch: Parameters<typeof requestListsRepo.updatePartial>[1] = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.dueDate !== undefined) patch.due_date = body.dueDate;
    if (body.status !== undefined) {
      patch.status = body.status;
      if (body.status === 'completed' && !list.completed_at) {
        patch.completed_at = new Date().toISOString();
      } else if (body.status !== 'completed' && list.completed_at) {
        patch.completed_at = null;
      }
    }
    const updated = await requestListsRepo.updatePartial(listId, patch, trx);
    if (!updated) throw new RequestsServiceError('not_found', 'list_disappeared');

    await auditRepo.write({
      actorUserId,
      action: body.status === 'cancelled' ? 'request.list_cancelled' : 'request.list_updated',
      targetType: 'request_list',
      targetId: listId,
      details: { fields: Object.keys(body) },
    });
    return presentList(updated);
  });
}

export async function cancelList(listId: string, actorUserId: string): Promise<RequestList> {
  return updateList(listId, { status: 'cancelled' }, actorUserId);
}

async function insertItemRow(
  listId: string,
  body: CreateRequestItemBody,
  fallbackSortOrder: number,
  trx: Knex.Transaction,
): Promise<RequestItemRow> {
  const titleBuf = Buffer.from(body.titleCiphertext, 'base64');
  const descBuf = body.descriptionCiphertext
    ? Buffer.from(body.descriptionCiphertext, 'base64')
    : null;
  return requestItemsRepo.insert(
    {
      list_id: listId,
      title_ciphertext: titleBuf,
      description_ciphertext: descBuf,
      content_key_version: body.contentKeyVersion,
      response_type: body.responseType,
      status: 'pending',
      sort_order: body.sortOrder ?? fallbackSortOrder,
      due_date: body.dueDate ?? null,
    },
    trx,
  );
}

export async function addItem(
  listId: string,
  body: CreateRequestItemBody,
  actorUserId: string,
): Promise<RequestItem> {
  return db.transaction(async (trx) => {
    const list = await loadListOr404(listId, trx);
    if (list.status !== 'active') {
      throw new RequestsServiceError('bad_state', 'list_not_active');
    }
    await assertStaffMember(list.conversation_id, actorUserId, trx);
    await assertValidContentKeyVersion(list.conversation_id, body.contentKeyVersion, trx);
    // Per-list cap.
    const itemCount = await trx('request_items')
      .where({ list_id: listId })
      .count<{ count: string }[]>('* as count')
      .first();
    if (Number(itemCount?.count ?? 0) >= MAX_ITEMS_PER_LIST) {
      throw new RequestsServiceError('bad_state', 'item_cap_reached', {
        cap: MAX_ITEMS_PER_LIST,
      });
    }
    // Default sort_order to "end of list" by max+1 unless caller pinned it.
    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const peak = await trx('request_items')
        .where({ list_id: listId })
        .max<{ max: number | null }[]>({ max: 'sort_order' })
        .first();
      sortOrder = (peak?.max ?? -1) + 1;
    }
    const row = await insertItemRow(listId, { ...body, sortOrder }, sortOrder, trx);
    await auditRepo.write({
      actorUserId,
      action: 'request.item_created',
      targetType: 'request_item',
      targetId: row.id,
      details: { listId, conversationId: list.conversation_id },
    });
    return presentItem(row);
  });
}

export async function updateItem(
  itemId: string,
  body: PatchRequestItemBody,
  actorUserId: string,
): Promise<RequestItem> {
  return db.transaction(async (trx) => {
    const { item, list } = await loadItemAndListOr404(itemId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);

    const patch: Parameters<typeof requestItemsRepo.updatePartial>[1] = {};
    if (body.titleCiphertext !== undefined) {
      patch.title_ciphertext = Buffer.from(body.titleCiphertext, 'base64');
    }
    if (body.descriptionCiphertext !== undefined) {
      patch.description_ciphertext = body.descriptionCiphertext
        ? Buffer.from(body.descriptionCiphertext, 'base64')
        : null;
    }
    if (body.contentKeyVersion !== undefined) {
      await assertValidContentKeyVersion(list.conversation_id, body.contentKeyVersion, trx);
      patch.content_key_version = body.contentKeyVersion;
    }
    if (body.responseType !== undefined) patch.response_type = body.responseType;
    if (body.sortOrder !== undefined) patch.sort_order = body.sortOrder;
    if (body.dueDate !== undefined) patch.due_date = body.dueDate;

    const updated = await requestItemsRepo.updatePartial(itemId, patch, trx);
    if (!updated) throw new RequestsServiceError('not_found', 'item_disappeared');
    await auditRepo.write({
      actorUserId,
      action: 'request.item_updated',
      targetType: 'request_item',
      targetId: itemId,
      details: {
        listId: item.list_id,
        conversationId: list.conversation_id,
        fields: Object.keys(body),
      },
    });
    return presentItem(updated);
  });
}

export async function deletePendingItem(itemId: string, actorUserId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const { item, list } = await loadItemAndListOr404(itemId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);
    if (item.status !== 'pending') {
      throw new RequestsServiceError('item_pending_only', 'item_must_be_pending_to_delete');
    }
    const deleted = await requestItemsRepo.deleteIfPending(itemId, trx);
    if (deleted === 0) {
      throw new RequestsServiceError('item_pending_only', 'item_must_be_pending_to_delete');
    }
    await auditRepo.write({
      actorUserId,
      action: 'request.item_deleted',
      targetType: 'request_item',
      targetId: itemId,
      details: { listId: item.list_id, conversationId: list.conversation_id },
    });
  });
}

/**
 * Auto-flip used by the message-create post-insert hook in 24.2. Fires when a
 * member's outgoing message carries `ciphertextMeta.requestItemId` and (per
 * the item's response_type rule) the message contributes the right kind of
 * payload. Idempotent — guarded WHERE on status, so a duplicate call is a
 * no-op. Returns the new item row when a transition fired, or null when no
 * change applied.
 *
 * Called WITH the message already inserted; we just check that the item
 * actually belongs to the message's conversation and that the response_type
 * rule is satisfied.
 *
 * `attachmentCount` lets us enforce response_type='file' (must have ≥1
 * attachment) and 'both' (file XOR text both ok). 'text' always satisfies.
 */
export async function onMessagePosted(args: {
  messageId: string;
  itemId: string;
  conversationId: string;
  attachmentCount: number;
  hasTextBody: boolean;
  /** sender — for audit attribution. Either staff user or external client. */
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
}): Promise<RequestItem | null> {
  // Phase 24 kill switch: skip the auto-flip when an admin has disabled the
  // Requests feature. The message itself is unaffected (still posts, still
  // fans out via offlineNotify); only the request-item linkage no-ops.
  const firmSettings = await db('firm_settings').where({ id: 1 }).first('requests_enabled');
  if (firmSettings && firmSettings.requests_enabled === false) return null;
  // Phase 24.5: a sibling attachment on this same message may have already
  // failed virus scan and walked the item back to `revision`. If so, refuse
  // to re-promote — otherwise a malicious client could attach a clean file
  // AFTER the infected one and silently re-flip the item to `submitted`,
  // hiding the rejection from staff. The check is fail-closed: any infected
  // attachment on the message blocks subsequent re-promotion forever.
  if (args.messageId) {
    const infected = await db('attachments')
      .where({ message_id: args.messageId, scan_status: 'infected' })
      .first('id');
    if (infected) {
      await auditRepo.write({
        actorUserId: args.actorUserId,
        actorExternalIdentityId: args.actorExternalIdentityId,
        action: 'request.item_link_rejected',
        targetType: 'request_item',
        targetId: args.itemId,
        details: {
          messageId: args.messageId,
          reason: 'sibling_attachment_infected',
        },
      });
      return null;
    }
  }
  return db.transaction(async (trx) => {
    const item = await requestItemsRepo.byId(args.itemId, trx);
    if (!item) return null;
    const list = await requestListsRepo.byId(item.list_id, trx);
    if (!list) return null;
    // Anti-tamper: a client could plant any UUID in ciphertextMeta. The item
    // must belong to the same conversation as the message.
    if (list.conversation_id !== args.conversationId) {
      await auditRepo.write({
        actorUserId: args.actorUserId,
        actorExternalIdentityId: args.actorExternalIdentityId,
        action: 'request.item_link_rejected',
        targetType: 'request_item',
        targetId: args.itemId,
        details: { messageId: args.messageId, reason: 'wrong_conversation' },
      });
      return null;
    }
    // Phase 24 follow-up: only `active` lists can auto-submit items.
    // Pre-fix, a client could keep posting against a cancelled list and
    // each post would still walk the item to `submitted`, leaving the
    // staff dashboard with submitted items under a cancelled list.
    if (list.status !== 'active') {
      await auditRepo.write({
        actorUserId: args.actorUserId,
        actorExternalIdentityId: args.actorExternalIdentityId,
        action: 'request.item_link_rejected',
        targetType: 'request_item',
        targetId: args.itemId,
        details: {
          messageId: args.messageId,
          reason: 'list_inactive',
          listStatus: list.status,
        },
      });
      return null;
    }
    // Response-type rule. 'file' demands an attachment; 'text' just needs the
    // message to exist; 'both' accepts either. Items already in `done` aren't
    // moved — staff explicitly closed them and a follow-up reply shouldn't
    // re-open. `revision` and `pending` both transition to `submitted`.
    const fileOk = args.attachmentCount > 0;
    const textOk = args.hasTextBody;
    let satisfied = false;
    switch (item.response_type) {
      case 'file':
        satisfied = fileOk;
        break;
      case 'text':
        satisfied = textOk;
        break;
      case 'both':
        satisfied = fileOk || textOk;
        break;
    }
    if (!satisfied) return null;
    const updated = await requestItemsRepo.transitionStatus(
      args.itemId,
      ['pending', 'revision'],
      'submitted',
      { submitted_at: new Date().toISOString(), revision_note_ciphertext: null },
      trx,
    );
    if (!updated) return null;
    await auditRepo.write({
      actorUserId: args.actorUserId,
      actorExternalIdentityId: args.actorExternalIdentityId,
      action: 'request.item_submitted',
      targetType: 'request_item',
      targetId: args.itemId,
      details: {
        messageId: args.messageId,
        conversationId: args.conversationId,
        listId: item.list_id,
      },
    });
    return presentItem(updated);
  });
}

/**
 * Phase 24.5 — server-side revert when an attachment that's tied to a
 * `submitted` request item fails ClamAV. The auto-flip in `onMessagePosted`
 * may have promoted the item to `submitted` because the staged text body or
 * an earlier attachment satisfied the response_type rule; if a sibling
 * attachment then turns out infected, we walk the item back to `revision`
 * so the staff workflow surfaces it as needing attention.
 *
 * We don't write to `revision_note_ciphertext` because the server has no
 * conversation key to encrypt under — clients render a hardcoded cleartext
 * "your last submission was rejected by virus scan, please re-upload"
 * message when an item is in `revision` and the ciphertext field is null.
 *
 * Returns the patched item when a transition fired, or null when the linked
 * item didn't exist, didn't belong to this conversation, or wasn't in
 * `submitted` (a `pending` or `revision` item is left alone — there's
 * nothing to walk back from).
 */
export async function onAttachmentScanFailed(args: {
  messageId: string;
  itemId: string;
  conversationId: string;
  reason: 'infected' | 'scan_unavailable';
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
}): Promise<RequestItem | null> {
  return db.transaction(async (trx) => {
    const item = await requestItemsRepo.byId(args.itemId, trx);
    if (!item) return null;
    const list = await requestListsRepo.byId(item.list_id, trx);
    if (!list || list.conversation_id !== args.conversationId) return null;
    const updated = await requestItemsRepo.transitionStatus(
      args.itemId,
      ['submitted'],
      'revision',
      {
        // Wipe any stale staff-authored note so the scan-failure cleartext
        // takes over on the client. Keep submitted_at intact for audit.
        revision_note_ciphertext: null,
      },
      trx,
    );
    if (!updated) return null;
    await auditRepo.write({
      actorUserId: args.actorUserId,
      actorExternalIdentityId: args.actorExternalIdentityId,
      action: 'request.item_scan_failed',
      targetType: 'request_item',
      targetId: args.itemId,
      details: {
        messageId: args.messageId,
        listId: item.list_id,
        conversationId: args.conversationId,
        reason: args.reason,
      },
    });
    return presentItem(updated);
  });
}

/**
 * Staff "Mark done" — transitions submitted/revision → done. If the move
 * makes every item in the list `done`, also auto-completes the list.
 */
export async function markDone(
  itemId: string,
  actorUserId: string,
): Promise<{ item: RequestItem; listCompleted: boolean }> {
  return db.transaction(async (trx) => {
    const { item, list } = await loadItemAndListOr404(itemId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);
    if (list.status !== 'active') {
      throw new RequestsServiceError('bad_state', 'list_not_active');
    }
    const updated = await requestItemsRepo.transitionStatus(
      itemId,
      ['submitted', 'revision'],
      'done',
      { completed_at: new Date().toISOString(), completed_by: actorUserId },
      trx,
    );
    if (!updated) {
      throw new RequestsServiceError('bad_state', 'item_not_in_submittable_state', {
        currentStatus: item.status,
      });
    }
    await auditRepo.write({
      actorUserId,
      action: 'request.item_marked_done',
      targetType: 'request_item',
      targetId: itemId,
      details: { listId: item.list_id, conversationId: list.conversation_id },
    });
    let listCompleted = false;
    const counts = await requestListsRepo.statusCounts(item.list_id, trx);
    if (
      counts.pending === 0 &&
      counts.submitted === 0 &&
      counts.revision === 0 &&
      counts.done > 0
    ) {
      // Race-safe completion: guarded UPDATE so two concurrent mark-done
      // calls on the last two items don't both fire `request.list_completed`
      // and double-write `completed_at`. Whichever transaction's UPDATE
      // matches first wins; the second sees `status != 'active'` and
      // returns 0 rows.
      const finalisedRows = await trx('request_lists')
        .where({ id: list.id, status: 'active' })
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: trx.fn.now(),
        });
      if (finalisedRows > 0) {
        listCompleted = true;
        await auditRepo.write({
          actorUserId,
          action: 'request.list_completed',
          targetType: 'request_list',
          targetId: list.id,
          details: { conversationId: list.conversation_id },
        });
      }
    }
    return { item: presentItem(updated), listCompleted };
  });
}

/**
 * Staff requests a revision. The revision_note ciphertext lives on the item
 * (so the portal can render it before unwrap) and will be echoed by the
 * route layer (24.2) into a system message in the thread.
 */
export async function requestRevision(
  itemId: string,
  noteCiphertext: string,
  contentKeyVersion: number,
  actorUserId: string,
): Promise<RequestItem> {
  return db.transaction(async (trx) => {
    const { item, list } = await loadItemAndListOr404(itemId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);
    // Allow revision on `active` AND `completed` lists — requesting revision
    // on a list that auto-completed should reopen it (handled below). Reject
    // archived/cancelled lists explicitly.
    if (list.status === 'archived' || list.status === 'cancelled') {
      throw new RequestsServiceError('bad_state', 'list_terminal');
    }
    await assertValidContentKeyVersion(list.conversation_id, contentKeyVersion, trx);
    const updated = await requestItemsRepo.transitionStatus(
      itemId,
      ['submitted', 'done'],
      'revision',
      {
        revision_note_ciphertext: Buffer.from(noteCiphertext, 'base64'),
        content_key_version: contentKeyVersion,
        // Re-opening clears the prior completion stamp.
        completed_at: null,
        completed_by: null,
      },
      trx,
    );
    if (!updated) {
      throw new RequestsServiceError('bad_state', 'item_not_revisable', {
        currentStatus: item.status,
      });
    }
    // Re-opening drops the list out of `completed` if it had auto-completed.
    if (list.status === 'completed') {
      await requestListsRepo.updatePartial(list.id, { status: 'active', completed_at: null }, trx);
    }
    await auditRepo.write({
      actorUserId,
      action: 'request.item_revision_requested',
      targetType: 'request_item',
      targetId: itemId,
      details: { listId: item.list_id, conversationId: list.conversation_id },
    });
    return presentItem(updated);
  });
}

/**
 * Retro-link an existing message (already in the thread, no `requestItemId`
 * in its meta) to an item. The route layer will patch
 * messages.ciphertext_meta to add `requestItemId` after this returns.
 */
export async function linkMessage(
  itemId: string,
  messageId: string,
  conversationId: string,
  actorUserId: string,
): Promise<RequestItemRow> {
  return db.transaction(async (trx) => {
    const { item, list } = await loadItemAndListOr404(itemId, trx);
    await assertStaffMember(list.conversation_id, actorUserId, trx);
    if (list.conversation_id !== conversationId) {
      throw new RequestsServiceError('wrong_conversation', 'message_in_other_conversation');
    }
    await auditRepo.write({
      actorUserId,
      action: 'request.message_linked',
      targetType: 'request_item',
      targetId: itemId,
      details: { messageId, listId: item.list_id, conversationId: list.conversation_id },
    });
    return item;
  });
}

// ---------- Nudges (Phase 24.7) ----------

export const requestNudgeSchema = z.object({
  // ISO timestamp; omit/null for "send immediately" (still goes through the
  // ticker — the row is enqueued with scheduled_for=NOW so the next tick
  // picks it up. This keeps audit + skip-check logic uniform between
  // manual and auto nudges.).
  sendAt: z.string().datetime().nullable().optional(),
  channel: z.enum(['inapp', 'email', 'sms', 'all']).default('all'),
  /** Optional staff-authored override of the default body. Capped at 500 chars to
   *  keep ciphertext_meta under its 4 KB ceiling. */
  customBody: z.string().max(500).nullable().optional(),
});

export interface EnqueueNudgeInput {
  listId: string;
  actorUserId: string;
  sendAt?: string | null;
  channel: 'inapp' | 'email' | 'sms' | 'all';
  customBody?: string | null;
}

const NUDGE_RATE_LIMIT_PER_LIST_PER_24H = 3;

// Phase 24.7 known-slop on the nudge rate limit: the SELECT count + INSERT
// sequence inside `enqueueNudge` / `enqueueAutoNudgeIfMissing` runs at the
// default READ COMMITTED isolation. Two concurrent enqueues (e.g., a manual
// click + an auto-sweeper iteration) can both observe count=2 and both
// insert, producing 4 nudges in 24h instead of the 3 cap. The race window
// is microseconds and the worst-case overage is +1 row per concurrent
// pair. We accept this slop because:
//   - the cap is a UX guard, not a security boundary
//   - SERIALIZABLE retry would add transaction-cost on every nudge for an
//     edge case that hits with two-staff-clicking-simultaneously frequency
//   - any over-cap nudge is still subject to the at-fire-time skip check
//     in scheduledMessages.ts (which drops nudges when the list completes)
// If a customer reports getting > 3 nudges/day on a single list, revisit:
// move to a partial unique index on (list_id, ⌊created_at / 8h⌋) keyed off
// `messages` and let unique-violation throw.

/**
 * Enqueue a "you have items pending" reminder. Implemented as a system
 * `messages` row with scheduled_for set; the existing scheduled-messages
 * ticker (services/scheduledMessages.ts) atomically claims the row and
 * fans out via `message:new`, which in turn rides the existing
 * offline-notify pipeline (email + SMS based on the recipient's prefs).
 *
 * We rate-limit to 3 nudges per list per 24h. The cap counts BOTH manual
 * and auto-nudge enqueues — so a manual nudge "burning" the budget for the
 * day is intentional, otherwise an over-zealous staff member could trip
 * auto-cadence on top of their own pings.
 */
export async function enqueueNudge(input: EnqueueNudgeInput): Promise<{ messageId: string }> {
  return db.transaction(async (trx) => {
    const list = await loadListOr404(input.listId, trx);
    await assertStaffMember(list.conversation_id, input.actorUserId, trx);
    if (list.status !== 'active') {
      throw new RequestsServiceError('bad_state', 'list_not_active');
    }
    // Rate-limit check uses the @> JSONB containment operator so it leans on
    // pg's GIN index on ciphertext_meta if one ever lands. For our row counts
    // it's a sequential scan over the last day's system messages — fast.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await trx('messages')
      .where('conversation_id', list.conversation_id)
      .andWhere('source', 'system')
      .andWhere('created_at', '>=', since)
      .whereRaw(`ciphertext_meta @> ?::jsonb`, [
        JSON.stringify({ systemEventType: 'request_nudge_sent', requestListId: list.id }),
      ])
      .count<{ count: string }[]>('* as count')
      .first();
    const recentCount = Number(recent?.count ?? 0);
    if (recentCount >= NUDGE_RATE_LIMIT_PER_LIST_PER_24H) {
      throw new RequestsServiceError('bad_state', 'nudge_rate_limited', {
        limit: NUDGE_RATE_LIMIT_PER_LIST_PER_24H,
        windowHours: 24,
      });
    }
    // Build the system message. Body ciphertext is empty — clients render
    // from `ciphertext_meta` (cleartext list title + status) to avoid a
    // server-side encrypt that would need a conversation key.
    const sendAtIso = input.sendAt ?? new Date().toISOString();
    const ciphertextMeta: Record<string, unknown> = {
      systemEventType: 'request_nudge_sent',
      requestListId: list.id,
      channelHint: input.channel,
      listTitle: list.title,
    };
    if (input.customBody && input.customBody.trim().length > 0) {
      ciphertextMeta.customBody = input.customBody.trim();
    }
    const [row] = await trx('messages')
      .insert({
        conversation_id: list.conversation_id,
        sender_id: input.actorUserId,
        ciphertext: Buffer.alloc(0),
        content_key_version: 0,
        urgent: false,
        scheduled_for: sendAtIso,
        source: 'system',
        ciphertext_meta: ciphertextMeta,
      })
      .returning(['id']);
    await auditRepo.write({
      actorUserId: input.actorUserId,
      action: 'request.nudge_scheduled',
      targetType: 'request_list',
      targetId: list.id,
      details: {
        messageId: row.id,
        conversationId: list.conversation_id,
        sendAt: sendAtIso,
        channel: input.channel,
        manual: true,
      },
    });
    return { messageId: row.id };
  });
}

/**
 * Auto-nudge sweeper helper — same insert path as `enqueueNudge` but with
 * an additional idempotency check that prevents the hourly job from
 * stacking duplicate nudges when it processes the same offset twice
 * (process restart, double-fired interval). Caller is the autoNudge
 * service; not used by HTTP routes.
 */
export async function enqueueAutoNudgeIfMissing(args: {
  listId: string;
  conversationId: string;
  /** ISO timestamp the nudge should fire at. Caller picks the moment;
   *  typically the END of the current sweeper hour so the next 15s tick
   *  picks it up cleanly. */
  scheduledForIso: string;
  offsetHours: number;
}): Promise<{ messageId: string } | null> {
  return db.transaction(async (trx) => {
    const list = await loadListOr404(args.listId, trx);
    if (list.status !== 'active') return null;
    if (list.conversation_id !== args.conversationId) return null;
    // Idempotency: if the same offset has already been enqueued for this
    // list, bail. The check is keyed on `requestListId + offsetHours`, so a
    // restart inside the target hour can't double-enqueue.
    const existing = await trx('messages')
      .where('conversation_id', args.conversationId)
      .andWhere('source', 'system')
      .whereRaw(`ciphertext_meta @> ?::jsonb`, [
        JSON.stringify({
          systemEventType: 'request_nudge_sent',
          requestListId: args.listId,
          autoOffsetHours: args.offsetHours,
        }),
      ])
      .first('id');
    if (existing) return null;
    // 3-per-24h rate-limit applies here too. Auto-nudges fire on a small
    // schedule but a misconfigured offsets list (e.g. [1,2,3,4]) shouldn't
    // overrun the cap.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await trx('messages')
      .where('conversation_id', args.conversationId)
      .andWhere('source', 'system')
      .andWhere('created_at', '>=', since)
      .whereRaw(`ciphertext_meta @> ?::jsonb`, [
        JSON.stringify({ systemEventType: 'request_nudge_sent', requestListId: args.listId }),
      ])
      .count<{ count: string }[]>('* as count')
      .first();
    if (Number(recent?.count ?? 0) >= NUDGE_RATE_LIMIT_PER_LIST_PER_24H) return null;
    const ciphertextMeta = {
      systemEventType: 'request_nudge_sent',
      requestListId: args.listId,
      channelHint: 'all',
      listTitle: list.title,
      autoOffsetHours: args.offsetHours,
    };
    const [row] = await trx('messages')
      .insert({
        conversation_id: args.conversationId,
        sender_id: list.created_by,
        ciphertext: Buffer.alloc(0),
        content_key_version: 0,
        urgent: false,
        scheduled_for: args.scheduledForIso,
        source: 'system',
        ciphertext_meta: ciphertextMeta,
      })
      .returning(['id']);
    await auditRepo.write({
      actorUserId: list.created_by,
      action: 'request.nudge_scheduled',
      targetType: 'request_list',
      targetId: args.listId,
      details: {
        messageId: row.id,
        conversationId: args.conversationId,
        sendAt: args.scheduledForIso,
        offsetHours: args.offsetHours,
        manual: false,
      },
    });
    return { messageId: row.id };
  });
}

// ---------- Templates ----------

export async function listTemplates(): Promise<RequestTemplate[]> {
  const rows = await requestTemplatesRepo.listActive();
  return rows.map(presentTemplate);
}

export async function createTemplate(
  body: CreateRequestTemplateBody,
  actorUserId: string,
): Promise<RequestTemplate> {
  try {
    const row = await requestTemplatesRepo.insert({
      name: body.name.trim(),
      description: body.description ?? null,
      item_specs: body.itemSpecs as unknown,
      created_by: actorUserId,
    });
    await auditRepo.write({
      actorUserId,
      action: 'request.template_created',
      targetType: 'request_template',
      targetId: row.id,
      details: { name: row.name, itemCount: body.itemSpecs.length },
    });
    return presentTemplate(row);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new RequestsServiceError('unique_violation', 'template_name_taken');
    }
    throw err;
  }
}

export async function updateTemplate(
  templateId: string,
  body: PatchRequestTemplateBody,
  actorUserId: string,
): Promise<RequestTemplate> {
  const existing = await requestTemplatesRepo.byId(templateId);
  if (!existing) throw new RequestsServiceError('not_found', 'template_not_found');
  if (existing.archived_at) {
    throw new RequestsServiceError('template_archived', 'template_archived');
  }
  const patch: Parameters<typeof requestTemplatesRepo.updatePartial>[1] = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description;
  if (body.itemSpecs !== undefined) patch.item_specs = body.itemSpecs as unknown;
  try {
    const updated = await requestTemplatesRepo.updatePartial(templateId, patch);
    if (!updated) throw new RequestsServiceError('not_found', 'template_disappeared');
    await auditRepo.write({
      actorUserId,
      action: 'request.template_updated',
      targetType: 'request_template',
      targetId: templateId,
      details: { fields: Object.keys(body) },
    });
    return presentTemplate(updated);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new RequestsServiceError('unique_violation', 'template_name_taken');
    }
    throw err;
  }
}

export async function archiveTemplate(
  templateId: string,
  actorUserId: string,
): Promise<RequestTemplate> {
  const updated = await requestTemplatesRepo.archive(templateId);
  if (!updated)
    throw new RequestsServiceError('not_found', 'template_not_found_or_already_archived');
  await auditRepo.write({
    actorUserId,
    action: 'request.template_archived',
    targetType: 'request_template',
    targetId: templateId,
    details: {},
  });
  return presentTemplate(updated);
}
