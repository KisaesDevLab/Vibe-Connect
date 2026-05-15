// Phase 28.5 (QA-followup) — shared tus 1.0.0 protocol primitives.
//
// Both `tusServer.ts` (Phase 26 vault) and `intakeTusServer.ts` (Phase 28
// intake) implement the same tus 1.0.0 wire protocol — `OPTIONS / POST /
// HEAD / PATCH / DELETE` with the same headers, same status codes, same
// stream-append-on-PATCH loop, same partial-file directory. The two
// paths differ in:
//
//   - auth model (vault: cookie-session / external-identity; intake:
//     Bearer JWT issued at session-create);
//   - row type and repo (vault_uploads_in_progress vs intake_uploads_in_progress);
//   - finalize hook (vault: scan + ciphertext-on-disk; intake: scan +
//     encrypt-and-store + intake_files row);
//   - on-the-wire payload shape (vault: ciphertext from client encryption;
//     intake: plaintext, then server-side encryption at rest).
//
// What's truly the same — the wire constants, path helpers, header
// preamble guards, metadata parser, and the chunk-streaming append on
// PATCH — lives here. Each caller composes these primitives into its
// own handler body so the auth / repo / finalize plumbing stays
// callsite-explicit. This dedup eliminates ~150 lines of copy-paste
// without forcing the two paths into a shared context shape they'd
// have to fight against later.
//
// CRYPTO posture note: this module touches plaintext bytes ONLY in the
// vault case where the client already pre-encrypted (so the bytes are
// already ciphertext from the server's perspective) and ONLY in the
// intake case briefly while the assembled plaintext sits on the
// encrypted Docker volume waiting for the finalize hook to scan,
// encrypt-at-rest, and unlink the partial. Neither path persists
// plaintext past the finalize boundary — see CLAUDE.md ADR-028
// (intake at rest) and the BRIDGE: comment trail elsewhere.
import type { Request, Response } from 'express';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,creation-with-upload,termination';

// ---------- Partial-file directory ----------

/**
 * Single shared partial-file directory for both vault and intake. The
 * uploadId is 32 bytes of hex from each caller's `randomBytes(32)`, so
 * the namespace doesn't collide between the two paths.
 */
export function tusIncomingDir(): string {
  return path.resolve(env.attachmentLocalDir, 'tus-incoming');
}

export async function ensureIncomingDir(): Promise<string> {
  const dir = tusIncomingDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function partFilePath(uploadId: string): string {
  // uploadId is hex-only (32 bytes) so no escaping needed.
  return path.join(tusIncomingDir(), `${uploadId}.part`);
}

// ---------- Header preamble guards ----------

/**
 * Apply the always-required `Tus-Resumable: 1.0.0` response header.
 * Call at the top of every handler before any other write.
 */
export function applyTusBaseHeaders(res: Response): void {
  res.setHeader('Tus-Resumable', TUS_VERSION);
}

/**
 * Verify the client sent `Tus-Resumable: 1.0.0`. Returns true if OK,
 * false (after writing a 412 response) if mismatched. Callers compose
 * this as the first non-baseline-header check in each handler.
 */
export function checkTusVersion(req: Request, res: Response): boolean {
  if (req.header('Tus-Resumable') !== TUS_VERSION) {
    res.status(412).json({ error: 'tus_version_mismatch' });
    return false;
  }
  return true;
}

/**
 * Verify the PATCH body's `Content-Type: application/offset+octet-stream`.
 * Returns true if OK, false (after writing 415) otherwise.
 */
export function checkPatchContentType(req: Request, res: Response): boolean {
  if (req.header('Content-Type') !== 'application/offset+octet-stream') {
    res.status(415).json({ error: 'invalid_content_type' });
    return false;
  }
  return true;
}

/**
 * Decode an Upload-Metadata header. tus encodes it as comma-separated
 * `key base64Value` pairs (single-space separated). Values are utf-8
 * base64; keys are ASCII tokens. Empty value (key with no space) means
 * the metadata key is set with empty string.
 *
 * Returns lowercased keys → decoded utf-8 strings. Returns null on parse
 * failure so the caller can 400.
 */
export function parseUploadMetadata(header: string | undefined): Record<string, string> | null {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const raw of header.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const sp = part.indexOf(' ');
    const key = sp === -1 ? part : part.slice(0, sp);
    const val = sp === -1 ? '' : part.slice(sp + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
    if (val) {
      try {
        out[key] = Buffer.from(val, 'base64').toString('utf8');
      } catch {
        return null;
      }
    } else {
      out[key] = '';
    }
  }
  return out;
}

// ---------- Stream-append (PATCH body) ----------

/**
 * Stream the inbound PATCH request body into the partial-file. Returns
 * the number of bytes written. Throws on any I/O error or when the
 * accumulated `expected + written` would exceed `expectedSize` (the
 * hard upload-length cap from tus protocol). Caller is responsible
 * for catching + responding 400.
 *
 * Why streaming, not buffered: tus is a resumable protocol — clients
 * routinely PATCH 50 MB chunks. Reading the whole chunk into memory
 * before writing would force the appliance to hold N concurrent
 * full-chunk Buffers, OOMing the box at modest concurrency. The
 * Node `req → writeStream` pipe with backpressure handles it cleanly.
 */
export async function streamAppendToPart(
  req: Request,
  uploadId: string,
  expectedOffset: number,
  expectedSize: number,
): Promise<number> {
  await ensureIncomingDir();
  const partPath = partFilePath(uploadId);
  let written = 0;
  const writeStream = createWriteStream(partPath, { flags: 'a' });
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      // Hard cap: refuse to exceed Upload-Length. We destroy the
      // request stream rather than continuing to buffer — the
      // pipeline propagates the error to the writeStream which
      // surfaces it through the `.on('error', reject)` below.
      if (written + expectedOffset > expectedSize) {
        req.destroy(new Error('exceeds_upload_length'));
      }
    });
    req.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    req.pipe(writeStream);
  });
  return written;
}
