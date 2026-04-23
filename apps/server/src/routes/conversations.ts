import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
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
  scheduledFor: z.string().datetime().nullable().optional(),
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
        lastMessagePreviewCiphertext: r.last_ciphertext
          ? r.last_ciphertext.toString('base64')
          : null,
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
    const keys = await conversationKeysRepo.latest(conv.id);
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
      rotationVersion: keys?.rotation_version ?? null,
      wrappedKeys: keys?.wrapped_keys ?? null,
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
    const row = await messagesRepo.insert({
      conversationId: req.params.id!,
      senderId: req.session.userId!,
      ciphertext: Buffer.from(parsed.data.ciphertext, 'base64'),
      contentKeyVersion: parsed.data.contentKeyVersion,
      urgent: parsed.data.urgent,
      scheduledFor: parsed.data.scheduledFor ?? null,
      source: 'app',
      ciphertextMeta: parsed.data.ciphertextMeta,
    });
    await conversationsRepo.touchUpdated(req.params.id!);
    // Only notify if the message is visible now (not scheduled in future).
    if (!row.scheduled_for || new Date(row.scheduled_for).getTime() <= Date.now()) {
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
    res
      .status(201)
      .json({ id: row.id, createdAt: row.created_at, scheduledFor: row.scheduled_for });
  }),
);

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
    const EDIT_WINDOW_MS = 15 * 60 * 1000;
    if (Date.now() - new Date(msg.created_at).getTime() > EDIT_WINDOW_MS) {
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
    await messagesRepo.softDelete(msg.id);
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

// ---------- Attachments ----------

const ATTACHMENT_DIR = path.resolve(env.attachmentLocalDir, 'attachments');
await fs.mkdir(ATTACHMENT_DIR, { recursive: true });

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
    // Store ciphertext on disk. File is already encrypted client-side.
    const storagePath = path.join(ATTACHMENT_DIR, `${msg.id}-${Date.now()}.bin`);
    await fs.writeFile(storagePath, req.file.buffer);
    const row = await attachmentsRepo.insert({
      message_id: msg.id,
      filename_ciphertext: meta.data.filenameCiphertext,
      mime_type: meta.data.mimeType,
      size_bytes: req.file.buffer.length,
      storage_path: path.relative(ATTACHMENT_DIR, storagePath),
      wrapped_file_key: Buffer.from(meta.data.wrappedFileKey, 'base64'),
      scan_status: 'pending',
    });
    // AV scan lands in Phase 21 via ClamAV sandbox; for Phase 4 we mark clean automatically.
    await attachmentsRepo.updateScanStatus(row.id, 'clean');
    res.status(201).json({
      id: row.id,
      storagePath: row.storage_path,
      sizeBytes: req.file.buffer.length,
      scanStatus: 'clean',
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
    // Path traversal defense: normalize the stored path and refuse to escape ATTACHMENT_DIR.
    const safeStored = path.basename(att.storage_path);
    const fullPath = path.join(ATTACHMENT_DIR, safeStored);
    if (!fullPath.startsWith(ATTACHMENT_DIR + path.sep) && fullPath !== ATTACHMENT_DIR) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const buf = await fs.readFile(fullPath);
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
