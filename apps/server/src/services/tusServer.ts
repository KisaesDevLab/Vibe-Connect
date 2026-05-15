// Phase 26 — Minimal tus 1.0.0 server for the Client Vault upload pipeline.
//
// Wire protocol primitives (constants, header guards, metadata parser,
// stream-append loop, partial-file path helpers) live in
// `services/tusProtocol.ts` — shared with `intakeTusServer.ts` (Phase 28).
// This file holds the vault-specific composition: auth model, repo
// adapter, create-context validation, and finalize hook.
//
// Protocol coverage:
//   Tus-Version       1.0.0
//   Tus-Resumable     1.0.0 (required on every request; mirrored on response)
//   Tus-Extension     creation,creation-with-upload,termination
//   Tus-Max-Size      from firm_settings.vault_max_file_bytes
//
// Endpoints (mounted by routes/vaultsUpload.ts and routes/portalVaultUpload.ts):
//   OPTIONS /uploads               capability discovery
//   POST    /uploads               create — body Upload-Length + Upload-Metadata
//   HEAD    /uploads/:uploadId     return Upload-Offset / Upload-Length
//   PATCH   /uploads/:uploadId     append; finalize when offset == length
//   DELETE  /uploads/:uploadId     cancel
//
// Resumable state lives in `vault_uploads_in_progress` (created_by binds the
// upload to its session — PATCH from a different session is rejected).
//
// Bytes-on-disk are CIPHERTEXT throughout. Clients encrypt the file body with
// a per-file key client-side before tus transmits anything; the partial chunks
// in `${ATTACHMENT_LOCAL_DIR}/tus-incoming/` and the final stored object are
// both ciphertext. ClamAV scans the assembled ciphertext (the same shape as
// message-attachment scanning).
import type { Request, Response } from 'express';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { vaultUploadsRepo, type VaultUploadRow } from '../repositories/vaults.js';
import { onTusUploadFinish, type TusFinishContext } from './vaultUploadService.js';
import {
  TUS_VERSION,
  TUS_EXTENSIONS,
  applyTusBaseHeaders,
  checkPatchContentType,
  checkTusVersion,
  ensureIncomingDir,
  parseUploadMetadata,
  partFilePath,
  streamAppendToPart,
  tusIncomingDir,
} from './tusProtocol.js';

const UPLOAD_TTL_SECONDS = 60 * 60 * 24; // 24h

// Re-export so existing call sites (tests, other modules) that imported
// `parseUploadMetadata` from `tusServer` keep working without a fan-out
// edit. New code should import from `tusProtocol.js` directly.
export { parseUploadMetadata };

export interface TusCreateAuth {
  /** Exactly one of these must be set. */
  userId: string | null;
  externalIdentityId: string | null;
}

export interface TusCreateContext {
  auth: TusCreateAuth;
  vaultId: string;
  zone: 'shared' | 'staff_only';
  folderId: string | null;
  expectedSize: number;
  metadata: Record<string, string>;
  /** URL prefix the client should PATCH to (e.g. `/clients/<id>/vault/uploads`). */
  uploadUrlPrefix: string;
}

// ---------- OPTIONS ----------

export function tusOptions(_req: Request, res: Response, maxSize: number): void {
  applyTusBaseHeaders(res);
  res.setHeader('Tus-Version', TUS_VERSION);
  res.setHeader('Tus-Extension', TUS_EXTENSIONS);
  res.setHeader('Tus-Max-Size', String(maxSize));
  res.status(204).end();
}

// ---------- POST (create) ----------

export async function tusCreate(
  req: Request,
  res: Response,
  ctx: TusCreateContext,
  maxSize: number,
): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const len = Number(req.header('Upload-Length'));
  if (!Number.isFinite(len) || len <= 0 || len !== Math.floor(len)) {
    res.status(400).json({ error: 'upload_length_required' });
    return;
  }
  if (len > maxSize) {
    res.status(413).json({ error: 'too_large', maxBytes: maxSize });
    return;
  }
  if (ctx.expectedSize !== len) {
    res.status(400).json({ error: 'upload_length_mismatch' });
    return;
  }
  const uploadId = randomBytes(32).toString('hex');
  await ensureIncomingDir();
  await fs.writeFile(partFilePath(uploadId), Buffer.alloc(0));
  await vaultUploadsRepo.insert({
    upload_url_id: uploadId,
    vault_id: ctx.vaultId,
    zone: ctx.zone,
    folder_id: ctx.folderId,
    expected_size: len,
    metadata: ctx.metadata,
    expires_at: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    created_by_user_id: ctx.auth.userId,
    created_by_external_identity_id: ctx.auth.externalIdentityId,
  });
  res.setHeader('Location', `${ctx.uploadUrlPrefix}/${uploadId}`);
  res.setHeader('Upload-Expires', new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toUTCString());
  res.status(201).end();
}

// ---------- HEAD ----------

export async function tusHead(req: Request, res: Response, uploadId: string): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const row = await vaultUploadsRepo.byUploadUrlId(uploadId);
  if (!row) {
    res.status(404).end();
    return;
  }
  res.setHeader('Upload-Offset', String(Number(row.bytes_received)));
  res.setHeader('Upload-Length', String(Number(row.expected_size)));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end();
}

// ---------- PATCH ----------

export async function tusPatch(
  req: Request,
  res: Response,
  uploadId: string,
  auth: TusCreateAuth,
  finishContext: Omit<TusFinishContext, 'upload' | 'metadata' | 'ciphertextBuffer'>,
): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  if (!checkPatchContentType(req, res)) return;
  const row = await vaultUploadsRepo.byUploadUrlId(uploadId);
  if (!row) {
    res.status(404).end();
    return;
  }
  if (!authMatches(row, auth)) {
    res.status(403).json({ error: 'session_mismatch' });
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
  await vaultUploadsRepo.setBytesReceived(uploadId, newOffset);
  if (newOffset === expectedSize) {
    // Finalize: read back the assembled ciphertext, scan, persist, audit.
    try {
      const ciphertext = await fs.readFile(partPath);
      const metadata = (row.metadata ?? {}) as Record<string, string>;
      await onTusUploadFinish({
        ...finishContext,
        upload: row,
        metadata,
        ciphertextBuffer: ciphertext,
      });
      // Best-effort cleanup of partial.
      try {
        await fs.unlink(partPath);
      } catch {
        /* swallow */
      }
      await vaultUploadsRepo.deleteByUploadUrlId(uploadId);
      res.setHeader('Upload-Offset', String(newOffset));
      res.status(204).end();
      return;
    } catch (err) {
      logger.error('vault_tus_finalize_failed', { uploadId, err: String(err) });
      // Drop the partial + the in-progress row so the upload doesn't sit
      // around as a half-completed ghost.
      try {
        await fs.unlink(partPath);
      } catch {
        /* swallow */
      }
      await vaultUploadsRepo.deleteByUploadUrlId(uploadId);
      const status = err instanceof TusFinalizeError ? err.status : 500;
      res.status(status).json({ error: 'finalize_failed', detail: (err as Error).message });
      return;
    }
  }
  res.setHeader('Upload-Offset', String(newOffset));
  res.status(204).end();
}

// ---------- DELETE (terminate) ----------

export async function tusDelete(
  req: Request,
  res: Response,
  uploadId: string,
  auth: TusCreateAuth,
): Promise<void> {
  applyTusBaseHeaders(res);
  if (!checkTusVersion(req, res)) return;
  const row = await vaultUploadsRepo.byUploadUrlId(uploadId);
  if (!row) {
    res.status(404).end();
    return;
  }
  if (!authMatches(row, auth)) {
    res.status(403).json({ error: 'session_mismatch' });
    return;
  }
  try {
    await fs.unlink(partFilePath(uploadId));
  } catch {
    /* missing partial — fine */
  }
  await vaultUploadsRepo.deleteByUploadUrlId(uploadId);
  res.status(204).end();
}

// ---------- Maintenance: reap expired uploads ----------

export async function reapExpiredTusUploads(): Promise<number> {
  // Find rows whose expires_at is past, delete partial files, then drop rows.
  // We list-and-delete in two steps to avoid holding the partial-file fd
  // across the DB delete.
  const dir = tusIncomingDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    /* already exists */
  }
  // Cheap path: just delete the rows; orphaned partials are reclaimed below.
  const dropped = await vaultUploadsRepo.reapExpired();
  // Sweep the incoming dir for orphaned partials older than the TTL.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return dropped;
  }
  // Disk-sweep cutoff is operator-tunable via TUS_ORPHAN_TTL_HOURS; the
  // upload-init expiry above (UPLOAD_TTL_SECONDS) stays at 24h so a
  // longer disk-sweep window can't accidentally hold DB rows past their
  // protocol-level Upload-Expires header. Defaults match the legacy
  // hardcoded behavior; raising the env keeps orphans on disk longer
  // for clients that resume late, lowering reclaims faster.
  const cutoff = Date.now() - env.tusOrphanTtlHours * 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.endsWith('.part')) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) await fs.unlink(full);
    } catch {
      /* swallow */
    }
  }
  return dropped;
}

// ---------- Helpers ----------

function authMatches(row: VaultUploadRow, auth: TusCreateAuth): boolean {
  if (auth.userId && row.created_by_user_id === auth.userId) return true;
  if (auth.externalIdentityId && row.created_by_external_identity_id === auth.externalIdentityId)
    return true;
  return false;
}

export class TusFinalizeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TusFinalizeError';
  }
}

// Re-export for upload service tests and external callers that imported
// these from `tusServer` before the tusProtocol extraction. New code
// should import from `tusProtocol.js` directly.
export { tusIncomingDir, partFilePath };
// Eslint: streaming pipeline import is reserved for future use (S3 multipart driver).
void pipeline;
void createReadStream;
