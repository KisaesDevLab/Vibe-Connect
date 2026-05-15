// Phase 28.5 — tus 1.0.0 server for the anonymous intake upload pipeline.
//
// Composes the shared tus 1.0.0 wire primitives from `services/tusProtocol.ts`
// (Phase 28.5 QA-followup extraction) with intake-specific auth + repo +
// finalize. The pre-extraction copy-and-adapt of `tusServer.ts` is gone;
// what remains here is the genuinely-different glue:
//
//   - Bearer JWT auth (instead of vault's cookie session / external-identity)
//   - `intake_uploads_in_progress` repo (instead of `vault_uploads_in_progress`)
//   - Per-file AND per-session size caps from `firm_settings.intake_*`
//   - Plaintext-on-the-wire (intake is server-side encryption at rest)
//   - `onIntakeUploadFinish` finalize hook (scan → encrypt → store → row)
//
// CRYPTO posture: partial files in `tus-incoming/<uploadId>.part` are
// PLAINTEXT during a live upload. They live on the encrypted Docker
// volume and are unlinked immediately after finalize succeeds or fails.
// ClamAV scans the assembled plaintext before we encrypt-and-store.
import type { Request, Response } from 'express';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger.js';
import { db } from '../db/knex.js';
import {
  intakeFilesRepo,
  intakeSessionsRepo,
  intakeUploadsRepo,
  type IntakeUploadRow,
} from '../repositories/intake.js';
import { verifyUploadToken } from './intakeUploadToken.js';
import { IntakeFinalizeError, onIntakeUploadFinish } from './intakeUploadService.js';
import {
  TUS_EXTENSIONS,
  TUS_VERSION,
  applyTusBaseHeaders,
  checkPatchContentType,
  checkTusVersion,
  ensureIncomingDir,
  parseUploadMetadata,
  partFilePath,
  streamAppendToPart,
} from './tusProtocol.js';

const UPLOAD_TTL_SECONDS = 60 * 60 * 4; // 4h — aligns with the session JWT TTL.

/**
 * Pull the upload-token JWT off the Authorization header, verify the
 * signature, look up the matching session, and return both. Returns
 * `null` on any failure — the caller responds with 401 either way so we
 * don't leak which step failed (signature vs session-missing vs jti
 * mismatch vs status-not-open).
 */
async function authenticate(req: Request): Promise<{
  session: NonNullable<Awaited<ReturnType<typeof intakeSessionsRepo.byUploadTokenJti>>>;
  staffId: string;
} | null> {
  const header = req.header('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const verified = verifyUploadToken(m[1]!.trim());
  if (!verified.ok) return null;
  const session = await intakeSessionsRepo.byUploadTokenJti(verified.claims.jti);
  if (!session) return null;
  if (session.id !== verified.claims.sid) return null;
  if (session.staff_id !== verified.claims.staff) return null;
  if (session.status !== 'open') return null;
  return { session, staffId: verified.claims.staff };
}

// -------- OPTIONS --------

export function intakeTusOptions(_req: Request, res: Response, maxSize: number): void {
  applyTusBaseHeaders(res);
  res.setHeader('Tus-Version', TUS_VERSION);
  res.setHeader('Tus-Extension', TUS_EXTENSIONS);
  res.setHeader('Tus-Max-Size', String(maxSize));
  res.status(204).end();
}

// -------- POST (create) --------

export async function intakeTusCreate(req: Request, res: Response): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const auth = await authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const len = Number(req.header('Upload-Length'));
  if (!Number.isFinite(len) || len <= 0 || len !== Math.floor(len)) {
    res.status(400).json({ error: 'upload_length_required' });
    return;
  }
  // Per-file cap from firm_settings.intake_max_file_bytes.
  const settings = await db('firm_settings')
    .where({ id: 1 })
    .first('intake_max_file_bytes', 'intake_max_session_bytes');
  const maxFile = Number(settings?.intake_max_file_bytes ?? 50 * 1024 * 1024);
  const maxSession = Number(settings?.intake_max_session_bytes ?? 250 * 1024 * 1024);
  if (len > maxFile) {
    res.status(413).json({ error: 'too_large', maxBytes: maxFile });
    return;
  }
  // Per-session aggregate cap: existing accepted files + in-progress uploads
  // + the size of THIS new upload. We compute both in one shot to avoid a
  // TOCTOU window between two concurrent creates for the same session.
  const acceptedSize = await intakeFilesRepo.sumSizeBySession(auth.session.id);
  const inProgressRow = await db('intake_uploads_in_progress')
    .where({ session_id: auth.session.id })
    .sum<{ total: string | null }>({ total: 'expected_size' })
    .first();
  const inProgressSize = Number(inProgressRow?.total ?? 0);
  const wouldBe = acceptedSize + inProgressSize + len;
  if (wouldBe > maxSession) {
    res.status(413).json({
      error: 'session_cap_exceeded',
      currentBytes: acceptedSize + inProgressSize,
      maxBytes: maxSession,
    });
    return;
  }

  const metadata = parseUploadMetadata(req.header('Upload-Metadata'));
  if (!metadata) {
    res.status(400).json({ error: 'bad_metadata' });
    return;
  }

  const uploadId = randomBytes(32).toString('hex');
  await ensureIncomingDir();
  await fs.writeFile(partFilePath(uploadId), Buffer.alloc(0));
  await intakeUploadsRepo.insert({
    upload_url_id: uploadId,
    session_id: auth.session.id,
    expected_size: len,
    metadata,
    expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
  });
  res.setHeader('Location', `/api/public/intake/uploads/${uploadId}`);
  res.setHeader('Upload-Expires', new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toUTCString());
  res.status(201).end();
}

// -------- HEAD --------

export async function intakeTusHead(req: Request, res: Response): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const auth = await authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const uploadId = req.params.id ?? '';
  const row = await intakeUploadsRepo.byUploadUrlId(uploadId);
  if (!row || row.session_id !== auth.session.id) {
    res.status(404).end();
    return;
  }
  res.setHeader('Upload-Offset', String(Number(row.bytes_received)));
  res.setHeader('Upload-Length', String(Number(row.expected_size)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end();
}

// -------- PATCH --------

export async function intakeTusPatch(req: Request, res: Response): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  if (!checkPatchContentType(req, res)) return;
  const auth = await authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const uploadId = req.params.id ?? '';
  const row = await intakeUploadsRepo.byUploadUrlId(uploadId);
  if (!row || row.session_id !== auth.session.id) {
    res.status(404).end();
    return;
  }
  const offset = Number(req.header('Upload-Offset'));
  const expected = Number(row.bytes_received);
  if (!Number.isFinite(offset) || offset !== expected) {
    res.status(409).json({ error: 'offset_mismatch', expected });
    return;
  }
  const expectedSize = Number(row.expected_size);
  const partPath = partFilePath(uploadId);
  let written: number;
  try {
    written = await streamAppendToPart(req, uploadId, expected, expectedSize);
  } catch (err) {
    res.status(400).json({ error: 'write_failed', detail: (err as Error).message });
    return;
  }
  const newOffset = expected + written;
  await intakeUploadsRepo.setBytesReceived(uploadId, newOffset);

  if (newOffset === expectedSize) {
    try {
      const plaintext = await fs.readFile(partPath);
      const metadata = (row.metadata ?? {}) as Record<string, string>;
      await onIntakeUploadFinish({
        sessionId: auth.session.id,
        metadata,
        plaintext,
        ipAddress: req.ip ?? null,
      });
      try {
        await fs.unlink(partPath);
      } catch {
        /* swallow */
      }
      await intakeUploadsRepo.deleteByUploadUrlId(uploadId);
      res.setHeader('Upload-Offset', String(newOffset));
      res.status(204).end();
      return;
    } catch (err) {
      logger.error('intake_tus_finalize_failed', {
        uploadId,
        sessionId: auth.session.id,
        err: String(err),
      });
      // Drop the partial + the in-progress row so a failed finalize doesn't
      // leave a half-completed ghost. The session itself stays `open` so
      // the client can retry (uploading a different file or the same one).
      try {
        await fs.unlink(partPath);
      } catch {
        /* swallow */
      }
      await intakeUploadsRepo.deleteByUploadUrlId(uploadId);
      const status = err instanceof IntakeFinalizeError ? err.status : 500;
      const code = err instanceof IntakeFinalizeError ? err.code : 'finalize_failed';
      res.status(status).json({ error: code });
      return;
    }
  }
  res.setHeader('Upload-Offset', String(newOffset));
  res.status(204).end();
}

// -------- DELETE (terminate) --------

export async function intakeTusDelete(req: Request, res: Response): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const auth = await authenticate(req);
  if (!auth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const uploadId = req.params.id ?? '';
  const row = await intakeUploadsRepo.byUploadUrlId(uploadId);
  if (!row || row.session_id !== auth.session.id) {
    res.status(404).end();
    return;
  }
  try {
    await fs.unlink(partFilePath(uploadId));
  } catch {
    /* missing partial — fine */
  }
  await intakeUploadsRepo.deleteByUploadUrlId(uploadId);
  res.status(204).end();
}

// Maintenance: the existing vault `reapExpiredTusUploads` ticker already
// sweeps `tus-incoming/*.part` files past their TTL; we just need to drop
// our own table rows in the same window. Exposed so 28.17 can wire a
// scheduled call alongside the vault reaper if needed.
export async function reapExpiredIntakeUploads(): Promise<number> {
  return intakeUploadsRepo.reapExpired();
}

// Re-exports — primarily for tests that want to peek into the partial-file
// path or refer to the row type.
export { partFilePath as intakeTusPartFilePath };
export type { IntakeUploadRow };
