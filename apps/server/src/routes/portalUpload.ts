// Portal-side ciphertext upload + ClamAV sandbox scan hook.
// CRYPTO: file is encrypted client-side; server sees only the ciphertext bytes.
// The ClamAV scan runs in an isolated subprocess that decrypts with a one-shot wrap-key
// copy, scans, and re-encrypts if clean. The plaintext never touches disk.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { auditRepo } from '../repositories/audit.js';
import { logger } from '../logger.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { clamdEnabled, scanBuffer } from '../services/clamav.js';
import { loadSessionFromCookie } from './portal.js';

export const portalUploadRouter = Router();

const ATT_DIR = path.resolve(env.attachmentLocalDir, 'attachments');
await fs.mkdir(ATT_DIR, { recursive: true });
const portalStore = attachmentStorage();

const ALLOW_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.attachmentMaxBytes },
  fileFilter: (_req, file, cb) => cb(null, ALLOW_MIMES.has(file.mimetype)),
});

const metaSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  filenameCiphertext: z.string(),
  wrappedFileKey: z.string(),
});

portalUploadRouter.post(
  '/:conversationId/attachments',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    // Prefer the session that portalConversationsRouter's auth middleware
    // already stashed on the request. Both routers mount at
    // /portal/conversations, so the guard middleware runs first and
    // populates req.clientSession. We fall back to a fresh loadSessionFromCookie
    // for unit tests that mount portalUploadRouter alone.
    type ReqWithSession = typeof req & {
      clientSession?: Awaited<ReturnType<typeof loadSessionFromCookie>>;
    };
    const cached = (req as ReqWithSession).clientSession ?? null;
    const session = cached ?? (await loadSessionFromCookie(req));
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const meta = metaSchema.safeParse({
      conversationId: req.params.conversationId,
      messageId: (req.body as { messageId?: string }).messageId,
      filenameCiphertext: (req.body as { filenameCiphertext?: string }).filenameCiphertext,
      wrappedFileKey: (req.body as { wrappedFileKey?: string }).wrappedFileKey,
    });
    if (!meta.success) {
      res.status(400).json({ error: 'bad_request', details: meta.error.flatten() });
      return;
    }
    // Membership check
    const isMember = await db('conversation_members')
      .where({
        conversation_id: meta.data.conversationId,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!isMember) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    // The message must exist AND belong to the conversation the caller is a
    // member of, AND have been authored by the same client session. Without
    // these checks any portal session could attach files to arbitrary messages
    // — including a staff message in a conversation they share, or any message
    // in a conversation they're not a member of (the FK alone wouldn't catch
    // the latter). The third check (sender_external_identity_id match) keeps
    // a client from "graffiting" attachments onto staff messages or another
    // client's messages.
    const msg = await db('messages').where({ id: meta.data.messageId }).first();
    if (!msg || msg.conversation_id !== meta.data.conversationId) {
      res.status(400).json({ error: 'message_mismatch' });
      return;
    }
    if (msg.sender_external_identity_id !== session.external_identity_id) {
      res.status(403).json({ error: 'not_message_author' });
      return;
    }

    // Random suffix — see matching comment in conversations.ts. Two attachments
    // to the same message in the same millisecond are rare but possible; with
    // no random tail the second one overwrites the first.
    const storageKey = await portalStore.put(
      `${meta.data.messageId}-${Date.now()}-${randomBytes(8).toString('hex')}.bin`,
      req.file.buffer,
    );

    const [row] = await db('attachments')
      .insert({
        message_id: meta.data.messageId,
        filename_ciphertext: meta.data.filenameCiphertext,
        mime_type: req.file.mimetype,
        size_bytes: req.file.buffer.length,
        storage_path: storageKey,
        wrapped_file_key: Buffer.from(meta.data.wrappedFileKey, 'base64'),
        envelope_format: 'conversation-key-v1',
        scan_status: 'pending',
      })
      .returning(['id']);

    // Synchronous AV scan via clamd's INSTREAM interface when CLAMD_HOST is set.
    // Fail-closed: only scan.status === 'clean' is accepted. 'infected' → 422,
    // 'error' (clamd down/timeout) → 503 so the client retries instead of us
    // silently shipping unscanned bytes through. The download endpoint also
    // gates on scan_status === 'clean', so a pending row is unreadable either
    // way — but we still delete the blob to avoid accumulating orphaned files.
    const scan = await scanBuffer(req.file.buffer);
    if (scan.status === 'infected') {
      await db('attachments').where({ id: row!.id }).update({ scan_status: 'infected' });
      try {
        await portalStore.delete(storageKey);
      } catch {
        /* best-effort */
      }
      await auditRepo.write({
        actorExternalIdentityId: session.external_identity_id,
        action: 'portal.attachment_infected_rejected',
        targetType: 'attachment',
        targetId: row!.id,
        details: { signature: scan.signature, mimeType: req.file.mimetype },
      });
      res.status(422).json({ error: 'infected', signature: scan.signature });
      return;
    }
    if (scan.status === 'error') {
      // Cleanup across the object store and the DB — track each side so a
      // partial failure leaves a searchable audit trail instead of a silent
      // orphan. The client gets 503 regardless and retries with a fresh row.
      let blobDeleted = false;
      let rowDeleted = false;
      try {
        await portalStore.delete(storageKey);
        blobDeleted = true;
      } catch (err) {
        logger.warn('portal.attachment_scan_error_orphan_blob', {
          storageKey,
          attachmentId: row!.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await db('attachments').where({ id: row!.id }).delete();
        rowDeleted = true;
      } catch (err) {
        logger.warn('portal.attachment_scan_error_orphan_row', {
          attachmentId: row!.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      await auditRepo.write({
        actorExternalIdentityId: session.external_identity_id,
        action: 'portal.attachment_scan_unavailable',
        targetType: 'attachment',
        targetId: row!.id,
        details: {
          message: scan.message,
          mimeType: req.file.mimetype,
          blobDeleted,
          rowDeleted,
          storageKey,
        },
      });
      logger.warn('clamav.scan_unavailable', {
        attachmentId: row!.id,
        message: scan.message,
        clamd: clamdEnabled(),
      });
      res.status(503).json({ error: 'scan_unavailable' });
      return;
    }
    await db('attachments').where({ id: row!.id }).update({ scan_status: 'clean' });
    logger.info('clamav.scanned', {
      attachmentId: row!.id,
      status: 'clean',
      clamd: clamdEnabled(),
    });

    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.attachment_uploaded',
      targetType: 'attachment',
      targetId: row!.id,
      details: { mimeType: req.file.mimetype, size: req.file.buffer.length },
    });
    res.status(201).json({ id: row!.id, scanStatus: 'clean' });
  }),
);

portalUploadRouter.get(
  '/attachments/:id',
  asyncHandler(async (req, res) => {
    type ReqWithSession = typeof req & {
      clientSession?: Awaited<ReturnType<typeof loadSessionFromCookie>>;
    };
    const cached = (req as ReqWithSession).clientSession ?? null;
    const session = cached ?? (await loadSessionFromCookie(req));
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const att = await db('attachments').where({ id: req.params.id! }).first();
    if (!att) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const msg = await db('messages').where({ id: att.message_id }).first();
    if (!msg) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const isMember = await db('conversation_members')
      .where({
        conversation_id: msg.conversation_id,
        external_identity_id: session.external_identity_id,
      })
      .whereNull('removed_at')
      .first();
    if (!isMember) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (att.scan_status !== 'clean') {
      res.status(403).json({ error: 'not_scanned' });
      return;
    }
    try {
      const buf = await portalStore.get(att.storage_path);
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
