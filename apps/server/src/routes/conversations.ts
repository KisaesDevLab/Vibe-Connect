import { Router, type Request } from 'express';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { clamdEnabled, scanBuffer } from '../services/clamav.js';
import {
  conversationKeysRepo,
  conversationMembersRepo,
  conversationsRepo,
} from '../repositories/conversations.js';
import { attachmentsRepo, messagesRepo, readReceiptsRepo } from '../repositories/messages.js';
import { publish } from '../realtime/pgFanout.js';
import {
  addMember,
  assertCallerIsMember,
  createConversation,
  removeMember,
} from '../services/conversationService.js';

export const conversationsRouter = Router();

/** Payloads — the server never sees plaintext. Clients upload ciphertext + wrapped keys. */

const createSchema = z.object({
  type: z.enum(['internal', 'external']),
  memberUserIds: z.array(z.string().uuid()).min(1).max(100),
  memberExternalIdentityIds: z.array(z.string().uuid()).optional(),
  displayName: z.string().max(255).nullable().optional(),
  wrappedKeys: z.record(z.string(), z.string()),
  rotationVersion: z.number().int().positive().default(1),
});

// Cap ciphertextMeta to keep the JSONB column from becoming a DoS vector.
const boundedMeta = z
  .record(z.string(), z.unknown())
  .default({})
  .refine((v) => JSON.stringify(v).length <= 4096, 'ciphertextMeta_too_large');

const messageCreateSchema = z.object({
  ciphertext: z.string().max(20 * 1024 * 1024), // base64 of a ~15MB binary is ~20MB
  contentKeyVersion: z.number().int().positive(),
  urgent: z.boolean().default(false),
  // scheduledFor must be null (send now) or strictly in the future. Without
  // this, a client can POST with scheduledFor=1970-01-01 and the row is
  // published immediately with a stale timestamp — the UI then renders it in
  // the wrong order and the sender's last_read advance points at a backdated
  // id. 1s of slop absorbs normal clock drift.
  scheduledFor: z
    .string()
    .datetime()
    .refine((s) => new Date(s).getTime() > Date.now() + 1000, {
      message: 'scheduledFor must be in the future',
    })
    .nullable()
    .optional(),
  ciphertextMeta: boundedMeta,
});

const messageEditSchema = z.object({
  ciphertext: z.string().max(20 * 1024 * 1024),
  ciphertextMeta: boundedMeta,
});

const memberAddSchema = z.object({
  userId: z.string().uuid().optional(),
  externalIdentityId: z.string().uuid().optional(),
  newWrappedKeys: z.record(z.string(), z.string()),
  rotationVersion: z.number().int().positive(),
});

const memberRemoveSchema = z.object({
  userId: z.string().uuid().optional(),
  externalIdentityId: z.string().uuid().optional(),
  rotatedWrappedKeys: z.record(z.string(), z.string()),
  rotationVersion: z.number().int().positive(),
});

// ---------- Conversations ----------

conversationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await conversationsRepo.listForUser(req.session.userId!);
    res.json({
      conversations: rows.map((r) => ({
        id: r.id,
        type: r.type,
        parentConversationId: r.parent_conversation_id,
        displayName: r.display_name,
        updatedAt: r.updated_at,
        unreadCount: Number(r.unread_count ?? 0),
        memberUserIds: r.member_user_ids ?? [],
        memberExternalIdentityIds: r.member_external_identity_ids ?? [],
        lastMessageId: r.last_message_id,
        lastMessageAt: r.last_message_at,
        // Preview ciphertext is no longer shipped in the list payload (see
        // repositories/conversations.ts listForUser comment). The field is
        // retained for API shape stability; clients fetch the actual message
        // from /messages when the conversation opens.
        lastMessagePreviewCiphertext: null,
        lastMessageContentKeyVersion: r.last_content_key_version,
      })),
    });
  }),
);

conversationsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    // External conversations include clients (external_identities). When the firm
    // has disabled client messaging, block creation of new ones. Existing external
    // conversations remain readable — this toggle gates *new* contact, not the
    // audit trail.
    if (parsed.data.type === 'external') {
      const settings = await db('firm_settings').where({ id: 1 }).first();
      if (!(settings?.client_messaging_enabled ?? true)) {
        res.status(403).json({ error: 'client_messaging_disabled' });
        return;
      }
    }
    const id = await createConversation({
      actorUserId: req.session.userId!,
      type: parsed.data.type,
      memberUserIds: parsed.data.memberUserIds,
      memberExternalIdentityIds: parsed.data.memberExternalIdentityIds,
      displayName: parsed.data.displayName ?? null,
      wrappedKeys: parsed.data.wrappedKeys,
      rotationVersion: parsed.data.rotationVersion,
    });
    res.status(201).json({ id });
  }),
);

conversationsRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const conv = await conversationsRepo.byId(req.params.id!);
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const members = await conversationMembersRepo.currentForConversation(conv.id);
    // Return every rotation version's wrapped_keys. A message carries a
    // `contentKeyVersion` and must be decrypted with the wrapped_keys from
    // THAT version — not the latest. Returning all versions also means we
    // don't need a separate history endpoint. `wrappedKeys` (latest) is
    // kept for backward compatibility with existing client code paths.
    const allKeys = await conversationKeysRepo.allVersions(conv.id);
    const latest = allKeys.length > 0 ? allKeys[allKeys.length - 1]! : null;
    const byVersion: Record<string, Record<string, string>> = {};
    for (const k of allKeys) byVersion[String(k.rotation_version)] = k.wrapped_keys ?? {};
    res.json({
      id: conv.id,
      type: conv.type,
      parentConversationId: conv.parent_conversation_id,
      displayName: conv.display_name,
      members: members.map((m) => ({
        userId: m.user_id,
        externalIdentityId: m.external_identity_id,
        joinedAt: m.joined_at,
      })),
      rotationVersion: latest?.rotation_version ?? null,
      wrappedKeys: latest?.wrapped_keys ?? null,
      wrappedKeysByVersion: byVersion,
    });
  }),
);

// ---------- Messages ----------

conversationsRouter.get(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const beforeId = (req.query.beforeId as string | undefined) ?? undefined;
    const rows = await messagesRepo.list(req.params.id!, { limit, beforeId });
    const withAtts = await Promise.all(
      rows.map(async (m) => {
        const atts = await attachmentsRepo.byMessage(m.id);
        return {
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderExternalIdentityId: m.sender_external_identity_id,
          ciphertext: m.ciphertext.toString('base64'),
          contentKeyVersion: m.content_key_version,
          urgent: m.urgent,
          scheduledFor: m.scheduled_for,
          source: m.source,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          deletedAt: m.deleted_at,
          ciphertextMeta: m.ciphertext_meta,
          attachments: atts.map((a) => ({
            id: a.id,
            messageId: a.message_id,
            filenameCiphertext: a.filename_ciphertext,
            mimeType: a.mime_type,
            sizeBytes: Number(a.size_bytes),
            storagePath: a.storage_path,
            wrappedFileKey: a.wrapped_file_key.toString('base64'),
            scanStatus: a.scan_status,
            envelopeFormat: a.envelope_format,
            createdAt: a.created_at,
          })),
        };
      }),
    );
    res.json({ messages: withAtts });
  }),
);

conversationsRouter.post(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const parsed = messageCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const idempotencyKey = readIdempotencyKey(req);
    if (idempotencyKey) {
      // Race-free claim of the idempotency slot. If another concurrent request already
      // owns this (key, user_id), our INSERT returns zero rows and we serve the cached
      // response. Otherwise we own the slot and proceed to create the message + fill in
      // `response` afterwards. No two concurrent senders can both create messages.
      const claimed = await db('idempotency_keys')
        .insert({
          key: idempotencyKey,
          user_id: req.session.userId!,
          response: db.raw(`'{}'::jsonb`),
        })
        .onConflict(['key', 'user_id'])
        .ignore()
        .returning('key');
      if (claimed.length === 0) {
        // Someone else is handling (or has handled) this key. Wait briefly for them
        // to fill in `response`, then return it. This is bounded and deterministic.
        for (let i = 0; i < 20; i++) {
          const prior = await db('idempotency_keys')
            .where({ key: idempotencyKey, user_id: req.session.userId! })
            .first();
          if (prior && prior.response && Object.keys(prior.response).length > 0) {
            res.status(200).set('X-Idempotent-Replay', 'true').json(prior.response);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        res.status(409).json({ error: 'idempotency_in_flight' });
        return;
      }
    }
    // Atomic insert + touchUpdated + setLastRead. Pre-fix these ran outside a
    // transaction, and a mid-sequence failure (DB hiccup between the insert
    // and the setLastRead) left the sidebar badge inflated for the sender
    // and/or the idempotency response empty for 5 minutes. The realtime
    // `publish` stays outside the transaction — fanout effects should only
    // fire after commit, never for a transaction that rolls back.
    const isVisibleNow =
      !parsed.data.scheduledFor || new Date(parsed.data.scheduledFor).getTime() <= Date.now();
    const row = await db.transaction(async (trx) => {
      const inserted = await messagesRepo.insert(
        {
          conversationId: req.params.id!,
          senderId: req.session.userId!,
          ciphertext: Buffer.from(parsed.data.ciphertext, 'base64'),
          contentKeyVersion: parsed.data.contentKeyVersion,
          urgent: parsed.data.urgent,
          scheduledFor: parsed.data.scheduledFor ?? null,
          source: 'app',
          ciphertextMeta: parsed.data.ciphertextMeta,
        },
        trx,
      );
      await conversationsRepo.touchUpdated(req.params.id!, trx);
      if (isVisibleNow) {
        // Sender has obviously read what they just wrote — keep their unread
        // badge from inflating. Scheduled sends stay "unread" until their
        // delivery time so the sender's own card surfaces the "outbox"
        // state in the sidebar.
        await conversationMembersRepo.setLastRead(
          req.params.id!,
          req.session.userId!,
          inserted.id,
          trx,
        );
      }
      return inserted;
    });
    if (isVisibleNow) {
      await publish({
        type: 'message:new',
        conversationId: row.conversation_id,
        messageId: row.id,
        senderId: row.sender_id,
        senderExternalIdentityId: row.sender_external_identity_id,
        urgent: row.urgent,
        createdAt: row.created_at,
      });
    }
    const response = {
      id: row.id,
      createdAt: row.created_at,
      scheduledFor: row.scheduled_for,
    };
    if (idempotencyKey) {
      await db('idempotency_keys')
        .where({ key: idempotencyKey, user_id: req.session.userId! })
        .update({ message_id: row.id, response: response as unknown as Record<string, unknown> });
    }
    res.status(201).json(response);
  }),
);

function readIdempotencyKey(req: Request): string | null {
  const raw = req.header('x-idempotency-key') ?? req.header('idempotency-key');
  if (!raw) return null;
  const trimmed = raw.trim();
  // Reasonable format: 1-128 chars from a URL-safe set. Clients pick a UUID.
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

conversationsRouter.patch(
  '/messages/:messageId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const msg = await messagesRepo.byId(req.params.messageId!);
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (msg.deleted_at) {
      res.status(400).json({ error: 'deleted' });
      return;
    }
    if (msg.sender_id !== req.session.userId!) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    // Ex-members shouldn't be able to edit prior messages.
    await assertCallerIsMember(msg.conversation_id, req.session.userId!);
    // Firm-configurable window (minutes). 0 = edits disabled. See the
    // matching migration for the compliance rationale. Looked up per-request
    // so an admin flipping the setting doesn't require a restart.
    const firmSettings = await db('firm_settings').where({ id: 1 }).first();
    const editWindowMinutes = Number(firmSettings?.message_edit_window_minutes ?? 15);
    if (editWindowMinutes <= 0) {
      res.status(400).json({ error: 'edits_disabled' });
      return;
    }
    const editWindowMs = editWindowMinutes * 60 * 1000;
    if (Date.now() - new Date(msg.created_at).getTime() > editWindowMs) {
      res.status(400).json({ error: 'edit_window_expired' });
      return;
    }
    const parsed = messageEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const updated = await messagesRepo.edit(
      msg.id,
      Buffer.from(parsed.data.ciphertext, 'base64'),
      parsed.data.ciphertextMeta,
    );
    // Bump conversation.updated_at so the sidebar reflects the edit's ordering.
    // Without this, a late edit to an older message wouldn't nudge the
    // conversation's place in the list-for-user query.
    await conversationsRepo.touchUpdated(msg.conversation_id);
    await publish({ type: 'message:edit', conversationId: msg.conversation_id, messageId: msg.id });
    res.json({ id: updated!.id, editedAt: updated!.edited_at });
  }),
);

conversationsRouter.delete(
  '/messages/:messageId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const msg = await messagesRepo.byId(req.params.messageId!);
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (msg.sender_id !== req.session.userId!) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    // Ex-members shouldn't be able to delete prior messages. The PATCH handler
    // above already enforces this; DELETE must match or a removed member keeps
    // a last-stroke channel to nuke their own history + fire message:delete
    // broadcasts to the current members.
    await assertCallerIsMember(msg.conversation_id, req.session.userId!);
    await messagesRepo.softDelete(msg.id);
    // Same ordering rationale as edit: the sidebar should reflect that
    // something changed in this conversation.
    await conversationsRepo.touchUpdated(msg.conversation_id);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'message.deleted',
      targetType: 'message',
      targetId: msg.id,
    });
    await publish({
      type: 'message:delete',
      conversationId: msg.conversation_id,
      messageId: msg.id,
    });
    res.json({ ok: true });
  }),
);

conversationsRouter.post(
  '/messages/:messageId/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const msg = await messagesRepo.byId(req.params.messageId!);
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await assertCallerIsMember(msg.conversation_id, req.session.userId!);
    await readReceiptsRepo.markRead(msg.id, req.session.userId!);
    await conversationMembersRepo.setLastRead(msg.conversation_id, req.session.userId!, msg.id);
    await publish({
      type: 'message:read',
      conversationId: msg.conversation_id,
      messageId: msg.id,
      userId: req.session.userId!,
      externalIdentityId: null,
      readAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  }),
);

// ---------- Members ----------

conversationsRouter.post(
  '/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const parsed = memberAddSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    await addMember(req.session.userId!, req.params.id!, parsed.data);
    res.json({ ok: true });
  }),
);

conversationsRouter.delete(
  '/:id/members',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const parsed = memberRemoveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    await removeMember(req.session.userId!, req.params.id!, parsed.data);
    res.json({ ok: true });
  }),
);

// CRYPTO: Additive rewrap of the conversation key. When a member enrolls a new
// device (or a new client portal session appears), any already-enrolled device
// that can still unwrap the conversation key seals a copy to the new recipient
// and PATCHes the entry in. The server accepts ONLY new keys — existing entries
// are never overwritten, so a racing or malicious member can't lock others out.
// Caller must already be a conversation member. No audit row per call (these
// fire frequently during normal multi-device use); we rely on /devices + auth
// audit to establish who rewrapped for whom.
const wrappedKeyEntryPattern = new RegExp(
  [
    '^[0-9a-f-]{36}:[A-Za-z0-9_-]{1,128}$', // userId:deviceId (staff device)
    '^client:[0-9a-f-]{36}:session:[0-9a-f-]{36}$', // external portal session
    '^client:[0-9a-f-]{36}:invite$', // pre-activation invite key
  ].join('|'),
);
const wrappedKeysPatchSchema = z.object({
  added: z
    .record(z.string(), z.string().min(1).max(2048))
    .refine(
      (m) => Object.keys(m).every((k) => wrappedKeyEntryPattern.test(k)),
      'added_key_format_invalid',
    )
    .refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 64, 'added_count_out_of_range'),
});

conversationsRouter.patch(
  '/:id/wrapped-keys',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCallerIsMember(req.params.id!, req.session.userId!);
    const parsed = wrappedKeysPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const latest = await conversationKeysRepo.latest(req.params.id!);
    if (!latest) {
      res.status(404).json({ error: 'no_conversation_key' });
      return;
    }
    const { added } = await conversationKeysRepo.mergeWrappedAdditive(
      latest.id,
      parsed.data.added,
    );
    if (added.length > 0) {
      // Wake every member's tabs — especially the device that just enrolled,
      // which may not have joined the conv: room yet.
      const members = await conversationMembersRepo.currentForConversation(req.params.id!);
      const memberUserIds = members
        .map((m) => m.user_id)
        .filter((v): v is string => typeof v === 'string');
      if (memberUserIds.length > 0) {
        await publish({
          type: 'conversation:wrapped-keys-updated',
          conversationId: req.params.id!,
          memberUserIds,
          addedRecipientIds: added,
        });
      }
      const { logger } = await import('../logger.js');
      logger.info('wrapped_keys_merged', {
        conversationId: req.params.id,
        actorUserId: req.session.userId,
        added,
      });
    }
    res.json({ ok: true, added, rotationVersion: latest.rotation_version });
  }),
);

// ---------- Attachments ----------

const ATTACHMENT_DIR = path.resolve(env.attachmentLocalDir, 'attachments');
await fs.mkdir(ATTACHMENT_DIR, { recursive: true });
const attStore = attachmentStorage();

const STAFF_ALLOW_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/zip',
  'application/octet-stream',
  'text/csv',
  'text/plain',
]);

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.attachmentMaxBytes },
  fileFilter: (_req, file, cb) => cb(null, STAFF_ALLOW_MIMES.has(file.mimetype)),
});

const attachmentSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  filenameCiphertext: z.string(),
  mimeType: z.string().max(128),
  wrappedFileKey: z.string(), // base64
});

conversationsRouter.post(
  '/:id/attachments',
  requireAuth,
  attachmentUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const meta = attachmentSchema.safeParse({
      conversationId: req.params.id,
      messageId: (req.body as { messageId?: string }).messageId,
      filenameCiphertext: (req.body as { filenameCiphertext?: string }).filenameCiphertext,
      mimeType: req.file.mimetype,
      wrappedFileKey: (req.body as { wrappedFileKey?: string }).wrappedFileKey,
    });
    if (!meta.success) {
      res.status(400).json({ error: 'bad_request', details: meta.error.flatten() });
      return;
    }
    await assertCallerIsMember(meta.data.conversationId, req.session.userId!);
    // Verify the message exists and belongs to the conversation.
    const msg = await messagesRepo.byId(meta.data.messageId);
    if (!msg || msg.conversation_id !== meta.data.conversationId) {
      res.status(400).json({ error: 'message_mismatch' });
      return;
    }
    // Store ciphertext via the configured driver. File is already encrypted client-side,
    // so neither the driver nor the storage backend ever sees plaintext.
    // Storage key carries msg.id for audit-log traceability, a timestamp for
    // human-readable sorting on the filesystem, AND a random suffix so two
    // attachments to the same message in the same millisecond can't collide
    // (a bare `${msg.id}-${Date.now()}` would overwrite). The random tail
    // also prevents an attacker who knows msg.id from guessing the storage
    // path — useful defense-in-depth if the attachments volume is ever
    // exposed by a misconfigured bucket policy or static-file route.
    const storageKey = await attStore.put(
      `${msg.id}-${Date.now()}-${randomBytes(8).toString('hex')}.bin`,
      req.file.buffer,
    );
    const row = await attachmentsRepo.insert({
      message_id: msg.id,
      filename_ciphertext: meta.data.filenameCiphertext,
      mime_type: meta.data.mimeType,
      size_bytes: req.file.buffer.length,
      storage_path: storageKey,
      wrapped_file_key: Buffer.from(meta.data.wrappedFileKey, 'base64'),
      scan_status: 'pending',
      envelope_format: 'conversation-key-v1',
    });
    // AV scan: if CLAMD_HOST is configured we stream the ciphertext through INSTREAM
    // (clamd pattern-matches on entropy-free payload, so this catches known-bad bytes
    // even without decryption). Absent clamd, scanBuffer() returns 'clean' immediately
    // (documented in `docs/ops/CLAMAV.md` for appliance operators). Fail-closed when
    // clamd is configured but unreachable: drop the row and return 503 so the client
    // retries instead of us marking unscanned bytes as clean.
    const scan = await scanBuffer(req.file.buffer);
    if (scan.status === 'infected') {
      await attachmentsRepo.updateScanStatus(row.id, 'infected');
      try {
        await attStore.delete(storageKey);
      } catch {
        /* best-effort */
      }
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'attachment.infected_rejected',
        targetType: 'attachment',
        targetId: row.id,
        details: { signature: scan.signature },
      });
      res.status(422).json({ error: 'infected', signature: scan.signature });
      return;
    }
    if (scan.status === 'error') {
      // Cleanup is cross-system (object store + DB), so partial failure is
      // possible. Track each side separately and audit-log any orphan so ops
      // can reconcile via scripts in docs/ops/. We always return 503 — the
      // client retries with a fresh row regardless of the cleanup outcome.
      let blobDeleted = false;
      let rowDeleted = false;
      try {
        await attStore.delete(storageKey);
        blobDeleted = true;
      } catch (err) {
        logger.warn('attachment.scan_error_orphan_blob', {
          storageKey,
          attachmentId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await attachmentsRepo.delete(row.id);
        rowDeleted = true;
      } catch (err) {
        logger.warn('attachment.scan_error_orphan_row', {
          attachmentId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await auditRepo.write({
        actorUserId: req.session.userId!,
        action: 'attachment.scan_unavailable',
        targetType: 'attachment',
        targetId: row.id,
        details: { message: scan.message, blobDeleted, rowDeleted, storageKey },
      });
      res.status(503).json({ error: 'scan_unavailable' });
      return;
    }
    await attachmentsRepo.updateScanStatus(row.id, 'clean');
    res.status(201).json({
      id: row.id,
      storagePath: row.storage_path,
      sizeBytes: req.file.buffer.length,
      scanStatus: 'clean',
      clamdEnabled: clamdEnabled(),
    });
  }),
);

conversationsRouter.get(
  '/attachments/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const att = await attachmentsRepo.byId(req.params.id!);
    if (!att) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const msg = await messagesRepo.byId(att.message_id);
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await assertCallerIsMember(msg.conversation_id, req.session.userId!);
    if (att.scan_status !== 'clean') {
      res.status(403).json({ error: 'not_scanned', scanStatus: att.scan_status });
      return;
    }
    try {
      const buf = await attStore.get(att.storage_path);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${att.id}.bin"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', String(buf.length));
      res.send(buf);
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  }),
);
