// Portal-side conversation + message routes. Gated on client session + (optionally) step-up.
// CRYPTO(STEPUP): wrapped conversation keys are only emitted when verified_until is valid.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { messagesRepo, readReceiptsRepo } from '../repositories/messages.js';
import { conversationsRepo } from '../repositories/conversations.js';
import { publish } from '../realtime/pgFanout.js';
import { logger } from '../logger.js';
import { notifyForNewMessage } from '../services/offlineNotify.js';
import { onMessagePosted } from '../services/requestsService.js';
import { loadSessionFromCookie } from './portal.js';

/**
 * Phase 24: pull the `requestItemId` linkage out of a message's
 * ciphertext_meta. Mirror of the helper in routes/conversations.ts —
 * duplicated here to keep both routers free of cross-imports.
 */
const REQUEST_ITEM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readRequestItemId(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  const v = (meta as { requestItemId?: unknown }).requestItemId;
  return typeof v === 'string' && REQUEST_ITEM_UUID.test(v) ? v : null;
}

export const portalConversationsRouter = Router();

portalConversationsRouter.use(
  asyncHandler(async (req, res, next) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as unknown as { clientSession: typeof session }).clientSession = session;
    next();
  }),
);

portalConversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const session = (req as unknown as { clientSession: { external_identity_id: string } })
      .clientSession;
    // Portal clients MUST only see `external` conversations. `internal` and
    // `internal_thread` are staff-only and the portal UI has no code path to
    // render them — but the individual-detail endpoint refuses them too, so
    // this belt-and-suspenders filter prevents a data-integrity bug from
    // landing a forbidden conversation in the sidebar list.
    const rows = await db('conversations as c')
      .innerJoin('conversation_members as cm', 'cm.conversation_id', 'c.id')
      .where({
        'cm.external_identity_id': session.external_identity_id,
        'c.type': 'external',
      })
      .whereNull('cm.removed_at')
      .select('c.id', 'c.display_name as displayName', 'c.updated_at as updatedAt')
      .orderBy('c.updated_at', 'desc');
    // Last-message hint: per-conversation metadata for the sidebar card so the
    // client can show "just now" / "2 replies" without a round trip. Minimal
    // payload — the actual ciphertext stays in the detail endpoint.
    const convIds = rows.map((r) => r.id as string);
    const lastByConv = new Map<string, { createdAt: string; source: string }>();
    if (convIds.length > 0) {
      const lastRows = (await db.raw(
        `SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.created_at, m.source
         FROM messages m
         WHERE m.conversation_id = ANY(?::uuid[])
           AND m.deleted_at IS NULL
           AND (m.scheduled_for IS NULL OR m.scheduled_for <= NOW())
         ORDER BY m.conversation_id, m.created_at DESC`,
        [convIds],
      )) as { rows: Array<{ conversation_id: string; created_at: string; source: string }> };
      for (const r of lastRows.rows) {
        lastByConv.set(r.conversation_id, { createdAt: r.created_at, source: r.source });
      }
    }
    res.json({
      conversations: rows.map((r) => {
        const hint = lastByConv.get(r.id as string);
        return {
          id: r.id,
          displayName: r.displayName,
          updatedAt: r.updatedAt,
          lastMessageAt: hint?.createdAt ?? null,
          lastMessageSource: hint?.source ?? null,
        };
      }),
    });
  }),
);

portalConversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: { id: string; external_identity_id: string; verified_until: string | null };
      }
    ).clientSession;

    // Membership check.
    const isMember = await db('conversation_members')
      .where({
        conversation_id: req.params.id!,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!isMember) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Phase 24: clients MUST NEVER see an internal_thread — belt-and-suspenders on top of
    // the membership check. If the conversation type is 'internal_thread' we refuse.
    const conv0 = await db('conversations').where({ id: req.params.id! }).first();
    if (!conv0 || conv0.type === 'internal_thread' || conv0.type === 'internal') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const identity = await db('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    // STEPUP: if the firm requires step-up verification and the session hasn't satisfied it,
    // refuse to hand over the wrapped keys. The client must complete /portal/stepup first.
    const stepupNeeded =
      Boolean(identity?.verification_required) &&
      Boolean(identity?.verification_last4_hash) &&
      (!session.verified_until || new Date(session.verified_until) < new Date());

    const conv = await db('conversations').where({ id: req.params.id! }).first();
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const keys = stepupNeeded
      ? null
      : await db('conversation_keys')
          .where({ conversation_id: conv.id })
          .orderBy('rotation_version', 'desc')
          .first();

    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: stepupNeeded ? 'portal.convkey_withheld_stepup' : 'portal.conversation_viewed',
      targetType: 'conversation',
      targetId: conv.id,
    });

    res.json({
      id: conv.id,
      displayName: conv.display_name,
      stepupRequired: stepupNeeded,
      rotationVersion: keys?.rotation_version ?? null,
      wrappedKeys: keys?.wrapped_keys ?? null,
    });
  }),
);

portalConversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: { external_identity_id: string; verified_until: string | null };
      }
    ).clientSession;
    const member = await db('conversation_members')
      .where({
        conversation_id: req.params.id!,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!member) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // STEPUP: mirror the gate on GET /:id. Even though the ciphertext is
    // useless without the wrapped conversation key (which /:id withholds),
    // sender IDs + timestamps + `source` are metadata that an attacker with
    // stolen credentials can mine before the legitimate client notices. No
    // body data is emitted until the client has satisfied step-up.
    const identity = await db('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    const stepupNeeded =
      Boolean(identity?.verification_required) &&
      Boolean(identity?.verification_last4_hash) &&
      (!session.verified_until || new Date(session.verified_until) < new Date());
    if (stepupNeeded) {
      res.json({ messages: [], stepupRequired: true });
      return;
    }
    // Phase 27: include deleted rows so the portal renders the "deleted"
    // placeholder for messages a staffer removed. Ciphertext + attachments
    // get stripped on the wire below; the DB row keeps the ciphertext for
    // admin recovery.
    const rows = await db('messages')
      .where({ conversation_id: req.params.id! })
      .where((b) => b.whereNull('scheduled_for').orWhere('scheduled_for', '<=', db.fn.now()))
      .orderBy('created_at', 'desc')
      .limit(100);
    // Attach one per-message attachments[] array. Staff API already does this
    // in routes/conversations.ts; portal needs the same shape so the client
    // can render inline image previews (and a normal download chip otherwise)
    // without having to round-trip to a separate endpoint per message.
    const orderedMessages = rows.reverse();
    const liveMessageIds = orderedMessages
      .filter((m) => m.deleted_at === null)
      .map((m) => m.id as string);
    const attachmentsByMessageId: Record<string, Array<Record<string, unknown>>> = {};
    if (liveMessageIds.length > 0) {
      const atts = await db('attachments')
        .whereIn('message_id', liveMessageIds)
        .select(
          'id',
          'message_id',
          'filename_ciphertext',
          'mime_type',
          'size_bytes',
          'wrapped_file_key',
          'scan_status',
          'envelope_format',
          'created_at',
        );
      for (const a of atts) {
        const key = a.message_id as string;
        if (!attachmentsByMessageId[key]) attachmentsByMessageId[key] = [];
        attachmentsByMessageId[key]!.push({
          id: a.id,
          messageId: a.message_id,
          filenameCiphertext: a.filename_ciphertext,
          mimeType: a.mime_type,
          sizeBytes: Number(a.size_bytes),
          wrappedFileKey: (a.wrapped_file_key as Buffer).toString('base64'),
          scanStatus: a.scan_status,
          envelopeFormat: a.envelope_format,
          createdAt: a.created_at,
        });
      }
    }
    res.json({
      messages: orderedMessages.map((m) => {
        const isDeleted = m.deleted_at !== null;
        return {
          id: m.id,
          senderId: m.sender_id,
          senderExternalIdentityId: m.sender_external_identity_id,
          ciphertext: isDeleted ? '' : (m.ciphertext as Buffer).toString('base64'),
          contentKeyVersion: m.content_key_version,
          urgent: m.urgent,
          source: m.source,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          deletedAt: m.deleted_at,
          // Phase 24: portal needs the cleartext metadata for system-source
          // messages (revision-requested, nudge-sent) so it can render them
          // without trying to decrypt the empty ciphertext. The blob is
          // already capped at 4 KiB by boundedMeta.
          ciphertextMeta: isDeleted ? null : (m.ciphertext_meta as Record<string, unknown> | null),
          attachments: attachmentsByMessageId[m.id as string] ?? [],
        };
      }),
    });
  }),
);

// -------- Send message --------
//
// Mirror of the staff `POST /conversations/:id/messages`, scoped to a portal
// client session. Same step-up gate as GET /:id/messages — without verified_until,
// the wrapped conversation key was never released to this session, so a write
// here would be ciphertext the client can't have produced legitimately.
//
// CRYPTO: ciphertext is opaque to the server. We just store + fan out.
const portalMessageCreateSchema = z.object({
  ciphertext: z.string().max(20 * 1024 * 1024),
  contentKeyVersion: z.number().int().positive(),
  ciphertextMeta: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((v) => JSON.stringify(v).length <= 4096, 'ciphertextMeta_too_large'),
});

portalConversationsRouter.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: {
          id: string;
          external_identity_id: string;
          verified_until: string | null;
        };
      }
    ).clientSession;
    const member = await db('conversation_members')
      .where({
        conversation_id: req.params.id!,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!member) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Phase 24: clients MUST NEVER write into an internal_thread (or internal).
    const conv = await db('conversations').where({ id: req.params.id! }).first();
    if (!conv || conv.type === 'internal_thread' || conv.type === 'internal') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // STEPUP: same gate as the read path — refuse writes until verified.
    const identity = await db('external_identities')
      .where({ id: session.external_identity_id })
      .first();
    const stepupNeeded =
      Boolean(identity?.verification_required) &&
      Boolean(identity?.verification_last4_hash) &&
      (!session.verified_until || new Date(session.verified_until) < new Date());
    if (stepupNeeded) {
      res.status(403).json({ error: 'stepup_required' });
      return;
    }
    const parsed = portalMessageCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const row = await messagesRepo.insert({
      conversationId: req.params.id!,
      senderExternalIdentityId: session.external_identity_id,
      ciphertext: Buffer.from(parsed.data.ciphertext, 'base64'),
      contentKeyVersion: parsed.data.contentKeyVersion,
      source: 'app',
      ciphertextMeta: parsed.data.ciphertextMeta,
    });
    await conversationsRepo.touchUpdated(req.params.id!);
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.message_sent',
      targetType: 'message',
      targetId: row.id,
    });
    await publish({
      type: 'message:new',
      conversationId: row.conversation_id,
      messageId: row.id,
      senderId: null,
      senderExternalIdentityId: session.external_identity_id,
      urgent: false,
      createdAt: row.created_at,
    });
    void notifyForNewMessage({
      conversationId: row.conversation_id,
      messageId: row.id,
      senderUserId: null,
      senderExternalIdentityId: session.external_identity_id,
      urgent: false,
    });
    // Phase 24: auto-flip a linked request item to `submitted` if the response
    // type is satisfied at message-create time (text or both). File-only
    // items wait for the attachment-create hook in portalUpload.ts.
    const linkedItemId = readRequestItemId(parsed.data.ciphertextMeta);
    if (linkedItemId) {
      const hasTextBody = row.ciphertext.length > 0;
      void onMessagePosted({
        messageId: row.id,
        itemId: linkedItemId,
        conversationId: row.conversation_id,
        attachmentCount: 0,
        hasTextBody,
        actorUserId: null,
        actorExternalIdentityId: session.external_identity_id,
      })
        .then((updated) => {
          if (updated) {
            void publish({
              type: 'request:changed',
              conversationId: row.conversation_id,
              listId: updated.listId,
              itemId: updated.id,
            });
          }
        })
        .catch((err) => {
          logger.warn('portal_request_item_link_hook_failed', {
            messageId: row.id,
            itemId: linkedItemId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
    res.status(201).json({
      id: row.id,
      createdAt: row.created_at,
    });
  }),
);

// -------- Mark message read (portal) --------
//
// Phase 27: portal clients now mark messages read so the destruct timer can
// arm on first non-sender view. The staff app already had this endpoint;
// before this we tracked client read state implicitly via the message GET,
// which gave no per-message granularity for the destruct trigger.
//
// The destruct stamp uses `WHERE destruct_at IS NULL` so concurrent reads
// from a multi-tab portal client cannot race-double-stamp.
portalConversationsRouter.post(
  '/messages/:messageId/read',
  asyncHandler(async (req, res) => {
    const session = (
      req as unknown as {
        clientSession: { external_identity_id: string };
      }
    ).clientSession;
    const msg = await messagesRepo.byId(req.params.messageId!);
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const member = await db('conversation_members')
      .where({
        conversation_id: msg.conversation_id,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!member) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await readReceiptsRepo.markReadExternal(msg.id, session.external_identity_id);
    // Phase 27: arm destruct timer. The reader is necessarily a non-sender —
    // portal clients post via `sender_external_identity_id`, so any message
    // they could read was sent by staff. We pass `readerUserId: null` and the
    // repo's predicate becomes a no-op for the sender check.
    if (msg.destruct_after_view_seconds !== null && msg.destruct_at === null) {
      const fireAt = new Date(Date.now() + msg.destruct_after_view_seconds * 1000);
      const stamped = await messagesRepo.stampDestructAt(msg.id, fireAt, null);
      if (stamped > 0) {
        await auditRepo.write({
          actorExternalIdentityId: session.external_identity_id,
          action: 'message.destruct_armed',
          targetType: 'message',
          targetId: msg.id,
          details: {
            conversationId: msg.conversation_id,
            fireAt: fireAt.toISOString(),
            afterViewSeconds: msg.destruct_after_view_seconds,
            via: 'portal',
          },
        });
      }
    }
    await publish({
      type: 'message:read',
      conversationId: msg.conversation_id,
      messageId: msg.id,
      userId: null,
      externalIdentityId: session.external_identity_id,
      readAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  }),
);
