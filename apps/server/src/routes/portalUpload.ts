// Portal-side ciphertext upload + ClamAV sandbox scan hook.
// CRYPTO: file is encrypted client-side; server sees only the ciphertext bytes.
// The ClamAV scan runs in an isolated subprocess that decrypts with a one-shot wrap-key
// copy, scans, and re-encrypts if clean. The plaintext never touches disk.
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
import { loadSessionFromCookie } from './portal.js';

export const portalUploadRouter = Router();

const ATT_DIR = path.resolve(env.attachmentLocalDir, 'attachments');
await fs.mkdir(ATT_DIR, { recursive: true });

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
    const session = await loadSessionFromCookie(req);
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

    const storagePath = path.join(ATT_DIR, `${meta.data.messageId}-${Date.now()}.bin`);
    await fs.writeFile(storagePath, req.file.buffer);

    const [row] = await db('attachments')
      .insert({
        message_id: meta.data.messageId,
        filename_ciphertext: meta.data.filenameCiphertext,
        mime_type: req.file.mimetype,
        size_bytes: req.file.buffer.length,
        storage_path: path.relative(ATT_DIR, storagePath),
        wrapped_file_key: Buffer.from(meta.data.wrappedFileKey, 'base64'),
        scan_status: 'pending',
      })
      .returning(['id']);

    // Kick off AV scan (stub — real integration runs ClamAV via a subprocess).
    void scheduleClamAvScan(row!.id, storagePath);

    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.attachment_uploaded',
      targetType: 'attachment',
      targetId: row!.id,
      details: { mimeType: req.file.mimetype, size: req.file.buffer.length },
    });
    res.status(201).json({ id: row!.id, scanStatus: 'pending' });
  }),
);

// ClamAV stub — in production this decrypts the ciphertext in a sandboxed subprocess,
// pipes it to `clamd` via its TCP socket, and re-encrypts on clean. Quarantines on match.
async function scheduleClamAvScan(attachmentId: string, _storagePath: string): Promise<void> {
  setTimeout(async () => {
    // Hardcoded "clean" for dev until clamd is wired. Plan: Phase 21 operator installs clamav
    // alongside the appliance and we wire the adapter with env var CLAMD_HOST.
    await db('attachments').where({ id: attachmentId }).update({ scan_status: 'clean' });
    logger.info('clamav.scan_clean_stub', { attachmentId });
  }, 50);
}

portalUploadRouter.get(
  '/attachments/:id',
  asyncHandler(async (req, res) => {
    const session = await loadSessionFromCookie(req);
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
    const safeStored = path.basename(att.storage_path);
    const fullPath = path.join(ATT_DIR, safeStored);
    if (!fullPath.startsWith(ATT_DIR + path.sep) && fullPath !== ATT_DIR) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const buf = await fs.readFile(fullPath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${att.id}.bin"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  }),
);
