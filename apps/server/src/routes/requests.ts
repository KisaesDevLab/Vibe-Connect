// Phase 24.2 — Staff-facing routes for request lists, items, templates.
//
// Two routers exported from this module:
//
//   * requestsRouter — flat top-level paths under `/request-lists`,
//     `/request-items`, `/request-templates`, `/requests`. Mounted from
//     app.ts at the root.
//
//   * conversationRequestsRouter — nested under `/conversations/:id/...`
//     for the "list-by-conversation" + "create-list" endpoints. Mounted as
//     a sibling of the existing conversations routes so the membership
//     middleware logic stays consistent with how the rest of the
//     conversation surface is keyed.
//
// All endpoints reuse `requireAuth`. Conversation-membership authorization
// is enforced inside requestsService.ts (single source of truth).
//
// Routes never touch the DB directly — they parse zod, call the service,
// translate RequestsServiceError codes to HTTP status, and emit
// `request:changed` realtime events on success.
import { Router, type Response as ExpressResponse } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { publish } from '../realtime/pgFanout.js';
import {
  RequestsServiceError,
  addItem,
  addItemSchema,
  archiveTemplate,
  cancelList,
  createList,
  createListSchema,
  createTemplate,
  deletePendingItem,
  enqueueNudge,
  getListWithItems,
  linkMessage,
  linkMessageSchema,
  listForConversation,
  listTemplates,
  markDone,
  patchItemSchema,
  patchListSchema,
  presentItem,
  presentList,
  requestNudgeSchema,
  requestRevision,
  requestRevisionSchema,
  requestTemplatePatchSchema,
  requestTemplateSchema,
  updateItem,
  updateList,
  updateTemplate,
} from '../services/requestsService.js';
import { messagesRepo } from '../repositories/messages.js';
import { db } from '../db/knex.js';
import { auditRepo } from '../repositories/audit.js';
import { conversationsRepo } from '../repositories/conversations.js';
import {
  notifyExternalRecipients,
  notifyForNewMessage,
} from '../services/offlineNotify.js';

// ---------- Error translation ----------

function statusForServiceError(err: RequestsServiceError): number {
  switch (err.code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'wrong_conversation':
      return 400;
    case 'bad_state':
    case 'item_pending_only':
    case 'template_archived':
      return 409;
    case 'unique_violation':
      return 409;
    default:
      return 400;
  }
}

function sendServiceError(res: ExpressResponse, err: unknown): void {
  if (err instanceof RequestsServiceError) {
    res.status(statusForServiceError(err)).json({
      error: err.code,
      detail: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  throw err;
}

// ---------- Routers ----------

/**
 * Phase 24 follow-up: firm-wide kill switch for the Requests feature
 * (`firm_settings.requests_enabled`). When disabled every endpoint in this
 * module 403s with a clear error code so the staff UI can render an
 * "admin disabled this" banner instead of a generic failure. Data is NOT
 * destroyed when the toggle flips off — re-enabling restores the prior
 * state. Mirrors the existing `client_messaging_enabled` middleware
 * pattern in routes/portal.ts.
 */
const requireRequestsEnabled = asyncHandler(async (_req, res, next) => {
  const settings = await db('firm_settings').where({ id: 1 }).first('requests_enabled');
  if (settings && settings.requests_enabled === false) {
    res.status(403).json({ error: 'requests_disabled' });
    return;
  }
  next();
});

export const requestsRouter = Router();
export const conversationRequestsRouter = Router({ mergeParams: true });

// Apply the kill switch to every endpoint in this module. The check runs
// per-request so an admin flipping the setting takes effect immediately
// without a server restart. requireAuth runs first at the router level so
// unauthenticated callers see 401 before anything tells them whether the
// firm has the feature on.
requestsRouter.use(requireAuth, requireRequestsEnabled);
conversationRequestsRouter.use(requireAuth, requireRequestsEnabled);

// ---------- /conversations/:id/request-lists ----------

conversationRequestsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const conversationId = req.params.id!;
    try {
      const lists = await listForConversation(conversationId, req.session.userId!);
      res.json({ lists });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

conversationRequestsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const conversationId = req.params.id!;
    const parsed = createListSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await createList({
        conversationId,
        createdBy: req.session.userId!,
        ...parsed.data,
      });
      // Tell every conversation member to refetch the panel.
      await publish({
        type: 'request:changed',
        conversationId,
        listId: result.id,
      });
      res.status(201).json({ list: result });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

// ---------- /request-lists/:id ----------

requestsRouter.get(
  '/request-lists/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const list = await getListWithItems(req.params.id!, req.session.userId!);
      res.json({ list });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.patch(
  '/request-lists/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = patchListSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const list = await updateList(req.params.id!, parsed.data, req.session.userId!);
      await publish({
        type: 'request:changed',
        conversationId: list.conversationId,
        listId: list.id,
      });
      res.json({ list });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.delete(
  '/request-lists/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const list = await cancelList(req.params.id!, req.session.userId!);
      await publish({
        type: 'request:changed',
        conversationId: list.conversationId,
        listId: list.id,
      });
      res.json({ list });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.post(
  '/request-lists/:id/items',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = addItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const item = await addItem(req.params.id!, parsed.data, req.session.userId!);
      // We need the conversationId for the publish; cheaper to query by item.list_id
      // than expanding the service signature.
      const list = await db('request_lists').where({ id: item.listId }).first('conversation_id');
      if (list) {
        await publish({
          type: 'request:changed',
          conversationId: list.conversation_id,
          listId: item.listId,
          itemId: item.id,
        });
      }
      res.status(201).json({ item });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

// ---------- /request-items/:id ----------

async function publishItemChange(itemId: string, listId: string): Promise<void> {
  const list = await db('request_lists').where({ id: listId }).first('conversation_id');
  if (!list) return;
  await publish({
    type: 'request:changed',
    conversationId: list.conversation_id,
    listId,
    itemId,
  });
}

requestsRouter.patch(
  '/request-items/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = patchItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const item = await updateItem(req.params.id!, parsed.data, req.session.userId!);
      await publishItemChange(item.id, item.listId);
      res.json({ item });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.delete(
  '/request-items/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      // Look up listId BEFORE the delete so we can still publish the event.
      const row = await db('request_items').where({ id: req.params.id! }).first('list_id');
      await deletePendingItem(req.params.id!, req.session.userId!);
      if (row) await publishItemChange(req.params.id!, row.list_id);
      res.status(204).end();
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.post(
  '/request-items/:id/mark-done',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const result = await markDone(req.params.id!, req.session.userId!);
      await publishItemChange(result.item.id, result.item.listId);
      res.json(result);
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.post(
  '/request-items/:id/request-revision',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = requestRevisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const item = await requestRevision(
        req.params.id!,
        parsed.data.noteCiphertext,
        parsed.data.contentKeyVersion,
        req.session.userId!,
      );
      // Post a system message into the thread so the client portal sees the
      // revision request inline alongside their other messages. The note
      // ciphertext is echoed onto the message's ciphertext_meta so the portal
      // can render it without a second fetch — the staff client encrypts the
      // note under the conversation's content key, so the portal already
      // has the key needed to decrypt it.
      const list = await db('request_lists')
        .where({ id: item.listId })
        .first('conversation_id', 'title');
      if (list) {
        const sysMsg = await messagesRepo.insert({
          conversationId: list.conversation_id,
          senderId: req.session.userId!,
          ciphertext: Buffer.alloc(0),
          contentKeyVersion: parsed.data.contentKeyVersion,
          source: 'system',
          ciphertextMeta: {
            systemEventType: 'request_item_revision',
            requestItemId: item.id,
            requestListId: item.listId,
            revisionNoteCiphertext: parsed.data.noteCiphertext,
          },
        });
        await conversationsRepo.touchUpdated(list.conversation_id);
        await publish({
          type: 'message:new',
          conversationId: list.conversation_id,
          messageId: sysMsg.id,
          senderId: req.session.userId!,
          senderExternalIdentityId: null,
          urgent: false,
          createdAt: sysMsg.created_at,
        });
        // Fan out via the staff offline-notify pipeline (other staff
        // members get a fallback ping). The portal client gets a separate
        // out-of-band dispatch via notifyExternalRecipients below since
        // notifyForNewMessage's recipient query is staff-only by design.
        void notifyForNewMessage({
          conversationId: list.conversation_id,
          messageId: sysMsg.id,
          senderUserId: req.session.userId!,
          senderExternalIdentityId: null,
          urgent: false,
        });
        // Phase 24 follow-up: deliver the revision-request to the client
        // via their stored email/SMS prefs. Metadata-only — the actual
        // revision note is E2EE in `revision_note_ciphertext`.
        const listTitleForClient = (list.title as string) ?? 'your request list';
        void notifyExternalRecipients({
          conversationId: list.conversation_id,
          subject: `Action needed for ${listTitleForClient}`,
          shortBody: `Your firm asked for a revision on an item in "${listTitleForClient}". Open the portal to see what's needed.`,
        });
        await publish({
          type: 'request:changed',
          conversationId: list.conversation_id,
          listId: item.listId,
          itemId: item.id,
        });
      }
      res.json({ item });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.post(
  '/request-items/:id/link-message',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = linkMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      // Find the message; refuse if it lives in a different conversation than
      // the item. The service-layer linkMessage() also enforces this — we
      // duplicate the lookup here to retrieve the conversation_id for the
      // metadata patch and authorization check below.
      const msg = await messagesRepo.byId(parsed.data.messageId);
      if (!msg) {
        res.status(404).json({ error: 'message_not_found' });
        return;
      }
      const item = await linkMessage(
        req.params.id!,
        parsed.data.messageId,
        msg.conversation_id,
        req.session.userId!,
      );
      // Patch the message's ciphertext_meta to include the linkage. This
      // makes the linkage queryable + visible in subsequent fetches without
      // separately joining a side table.
      const newMeta: Record<string, unknown> = {
        ...(msg.ciphertext_meta ?? {}),
        requestItemId: item.id,
      };
      await db('messages')
        .where({ id: parsed.data.messageId })
        .update({ ciphertext_meta: newMeta });
      await publish({
        type: 'request:changed',
        conversationId: msg.conversation_id,
        listId: item.list_id,
        itemId: item.id,
      });
      res.json({ ok: true });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

// ---------- /request-lists/:id/nudge ----------

requestsRouter.post(
  '/request-lists/:id/nudge',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = requestNudgeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await enqueueNudge({
        listId: req.params.id!,
        actorUserId: req.session.userId!,
        sendAt: parsed.data.sendAt ?? null,
        channel: parsed.data.channel,
        customBody: parsed.data.customBody ?? null,
      });
      res.status(202).json({ messageId: result.messageId });
    } catch (err) {
      if (err instanceof RequestsServiceError && err.code === 'bad_state' && err.message === 'nudge_rate_limited') {
        res.status(429).json({
          error: 'rate_limited',
          detail: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
        return;
      }
      sendServiceError(res, err);
    }
  }),
);

// ---------- /request-templates ----------

requestsRouter.get(
  '/request-templates',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const templates = await listTemplates();
    res.json({ templates });
  }),
);

// Templates write paths are admin-only — they're firm-wide config that
// every staff member's New-list modal pulls from. The GET listing is open
// to any staff so applying templates from the panel works without a
// privilege bump.
requestsRouter.post(
  '/request-templates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = requestTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const template = await createTemplate(parsed.data, req.session.userId!);
      res.status(201).json({ template });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.patch(
  '/request-templates/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = requestTemplatePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const template = await updateTemplate(
        req.params.id!,
        parsed.data,
        req.session.userId!,
      );
      res.json({ template });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

requestsRouter.delete(
  '/request-templates/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    try {
      const template = await archiveTemplate(req.params.id!, req.session.userId!);
      res.json({ template });
    } catch (err) {
      sendServiceError(res, err);
    }
  }),
);

// ---------- /requests/dashboard ----------
//
// Bulk view of every active request list across the conversations the
// caller is a member of. The query joins request_lists → request_items →
// conversations and aggregates item counts + last-activity per list. We
// keep the row shape skinny (cleartext list metadata + per-status item
// counts + last activity); item titles aren't returned because they're
// E2EE and would force the dashboard into per-row decryption.
//
// Filters / sort happen client-side — the result set is bounded by the
// caller's conversation membership, which a single appliance won't grow
// past a few hundred lists in practice. If that ever becomes false this
// endpoint can move to keyset pagination + server-side filters.
requestsRouter.get(
  '/requests/dashboard',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    // Limit to lists in conversations the caller is a current member of.
    // Excluding archived + cancelled keeps the dashboard a "what needs
    // attention" surface; closed engagements live in conversation history.
    const rows = (await db.raw(
      `WITH my_convs AS (
         SELECT DISTINCT cm.conversation_id
         FROM conversation_members cm
         WHERE cm.user_id = ? AND cm.removed_at IS NULL
       ),
       counts AS (
         SELECT
           ri.list_id,
           SUM(CASE WHEN ri.status = 'pending' THEN 1 ELSE 0 END)::int AS pending,
           SUM(CASE WHEN ri.status = 'submitted' THEN 1 ELSE 0 END)::int AS submitted,
           SUM(CASE WHEN ri.status = 'done' THEN 1 ELSE 0 END)::int AS done,
           SUM(CASE WHEN ri.status = 'revision' THEN 1 ELSE 0 END)::int AS revision,
           MAX(ri.updated_at) AS last_item_activity
         FROM request_items ri
         GROUP BY ri.list_id
       )
       SELECT
         rl.id, rl.conversation_id, rl.title, rl.description,
         rl.due_date, rl.status, rl.created_by, rl.template_id,
         rl.created_at, rl.updated_at, rl.completed_at,
         c.display_name AS conversation_display_name,
         COALESCE(counts.pending, 0)   AS pending_count,
         COALESCE(counts.submitted, 0) AS submitted_count,
         COALESCE(counts.done, 0)      AS done_count,
         COALESCE(counts.revision, 0)  AS revision_count,
         COALESCE(counts.last_item_activity, rl.updated_at) AS last_activity_at
       FROM request_lists rl
       INNER JOIN my_convs mc ON mc.conversation_id = rl.conversation_id
       LEFT JOIN conversations c ON c.id = rl.conversation_id
       LEFT JOIN counts ON counts.list_id = rl.id
       WHERE rl.status IN ('active', 'completed')
       ORDER BY
         CASE WHEN rl.status = 'active' THEN 0 ELSE 1 END,
         rl.due_date NULLS LAST,
         rl.updated_at DESC
       LIMIT 500`,
      [userId],
    )) as { rows: Array<Record<string, unknown>> };
    interface DashboardRowOut {
      list: ReturnType<typeof presentList>;
      conversationDisplayName: string | null;
      itemCounts: { pending: number; submitted: number; done: number; revision: number };
      lastActivityAt: string | null;
    }
    const out: DashboardRowOut[] = rows.rows.map((r) => ({
      list: presentList({
        id: r.id as string,
        conversation_id: r.conversation_id as string,
        title: r.title as string,
        description: (r.description as string | null) ?? null,
        due_date: (r.due_date as string | null) ?? null,
        status: r.status as 'active' | 'completed' | 'archived' | 'cancelled',
        created_by: r.created_by as string,
        template_id: (r.template_id as string | null) ?? null,
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
        completed_at: (r.completed_at as string | null) ?? null,
      }),
      conversationDisplayName: (r.conversation_display_name as string | null) ?? null,
      itemCounts: {
        pending: Number(r.pending_count ?? 0),
        submitted: Number(r.submitted_count ?? 0),
        done: Number(r.done_count ?? 0),
        revision: Number(r.revision_count ?? 0),
      },
      lastActivityAt: (r.last_activity_at as string | null) ?? null,
    }));
    res.json({ rows: out });
  }),
);

// Re-exports useful for tests + 24.6 dashboard wiring.
export { presentItem, presentList };

// Audit helper — exposed so the 24.6 dashboard can re-use it. Not currently
// used internally; placeholder to prevent unused-import lint when 24.6 lands.
export { auditRepo };
