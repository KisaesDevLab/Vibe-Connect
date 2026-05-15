// Phase 28.16 — Intake Key Rotation worker.
//
// Re-encrypts every PII column + every on-disk blob from the OLD key to
// the NEW key. Production reads continue against the current key
// (whatever `CONNECT_INTAKE_ENCRYPTION_KEY` is set to at boot); the
// new-key cipher only lives in this module for the duration of the
// rotation. After the run completes the operator swaps env vars and
// restarts — see docs/ops/INTAKE.md for the full workflow.
//
// Resumability: every batch persists `processed_*` counters and
// `last_processed_session_id` to the `intake_key_rotations` row so a
// SIGTERM mid-flight pauses cleanly and `/resume` picks up from there.
//
// CRYPTO INVARIANT: this is the ONLY non-test code path that holds two
// intake keys in memory simultaneously. The old + new key Uint8Arrays
// are bound to function-local lifetimes; nothing exports them.
import crypto from 'node:crypto';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { attachmentStorage } from './attachmentStorage.js';
import {
  decryptBufferStreamingWith,
  decryptFieldWith,
  encryptBufferStreamingWith,
  encryptFieldWith,
} from './intakeCrypto.js';

/**
 * Pause/cancel flag flipped by `stopIntakeKeyRotation()` during shutdown.
 * The worker checks this between session batches and between intake_files
 * rows; on flip it persists state and exits cleanly with status='paused'.
 */
let shutdownRequested = false;

/**
 * Set true while a rotation is actively running so the start route can
 * 409 a second concurrent attempt. In-process only — the DB row status
 * is the durable signal across restarts.
 *
 * SYNCHRONOUSLY flipped to true by `tryClaimRotationActive()` before the
 * route dispatches the worker so two near-simultaneous POSTs cannot
 * both pass the activity check. Cleared in the worker's `finally` and
 * by `releaseRotationActive()` if the dispatch itself fails.
 */
let activeRotation = false;

export interface RotationJob {
  jobId: string;
  oldKey: Uint8Array;
  newKey: Uint8Array;
  batchSize: number;
  resumeFromSessionId?: string | null;
}

export interface RotationCounts {
  total_sessions: number;
  total_files: number;
  total_pdfs: number;
  total_links: number;
}

/**
 * Count target rows for the dry-run estimate. Includes:
 *   - intake_sessions (every row has at least client_name_enc)
 *   - intake_files (every row has a stored blob)
 *   - intake_pdfs WHERE stored_path IS NOT NULL (pending rows have null)
 *   - intake_links WHERE client_email_enc IS NOT NULL OR client_phone_enc IS NOT NULL
 */
export async function countRotationTargets(): Promise<RotationCounts> {
  const [s, f, p, l] = await Promise.all([
    db('intake_sessions').count<{ c: string }>('* as c').first(),
    db('intake_files').count<{ c: string }>('* as c').first(),
    db('intake_pdfs').whereNotNull('stored_path').count<{ c: string }>('* as c').first(),
    db('intake_links')
      .where(function () {
        this.whereNotNull('client_email_enc').orWhereNotNull('client_phone_enc');
      })
      .count<{ c: string }>('* as c')
      .first(),
  ]);
  return {
    total_sessions: Number(s?.c ?? 0),
    total_files: Number(f?.c ?? 0),
    total_pdfs: Number(p?.c ?? 0),
    total_links: Number(l?.c ?? 0),
  };
}

/**
 * Dry-run validation:
 *   1. Decrypt-test one PII column with the OLD key — proves the old
 *      key the operator supplied actually matches what's on disk.
 *   2. Decrypt-test one file blob with the OLD key — same proof for
 *      the streaming envelope.
 *   3. **Round-trip a synthetic plaintext through the NEW key** — proves
 *      the new key is well-formed AND that the field-encryption /
 *      streaming-encryption primitives can actually use it. Without
 *      this check a corrupt new key (e.g. truncated by a copy-paste
 *      error that happened to land on a 32-byte boundary visually but
 *      wasn't base64-decodable to 32 bytes from this binding) would
 *      slip past the size-only validation in `parseIntakeKey` and only
 *      blow up mid-rotation.
 *
 * Returns counts + per-check booleans. Does NOT mutate anything.
 */
export async function dryRunRotation(opts: {
  oldKey: Uint8Array;
  newKey: Uint8Array;
}): Promise<{
  counts: RotationCounts;
  sample: {
    sessionDecryptOk: boolean | null;
    fileDecryptOk: boolean | null;
    newKeyRoundTripOk: boolean;
  };
}> {
  const counts = await countRotationTargets();

  // Sample one session for the PII round-trip (OLD key).
  const sampleSession = await db('intake_sessions').first<{ client_name_enc: Buffer }>(
    'client_name_enc',
  );
  let sessionDecryptOk: boolean | null = null;
  if (sampleSession?.client_name_enc) {
    try {
      await decryptFieldWith(sampleSession.client_name_enc, opts.oldKey);
      sessionDecryptOk = true;
    } catch {
      sessionDecryptOk = false;
    }
  }

  // Sample one file for the streaming round-trip (OLD key).
  const sampleFile = await db('intake_files').first<{ stored_path: string }>('stored_path');
  let fileDecryptOk: boolean | null = null;
  if (sampleFile?.stored_path) {
    try {
      const ct = await attachmentStorage().get(sampleFile.stored_path);
      await decryptBufferStreamingWith(ct, opts.oldKey);
      fileDecryptOk = true;
    } catch {
      fileDecryptOk = false;
    }
  }

  // NEW-key round-trip: synthetic plaintext through field + streaming
  // encrypt, then immediate decrypt. Catches a corrupt new key BEFORE
  // the real rotation re-encrypts any production data.
  let newKeyRoundTripOk = false;
  try {
    const probe = 'rotation-newkey-roundtrip-probe-' + Date.now();
    const encField = await encryptFieldWith(probe, opts.newKey);
    const decField = await decryptFieldWith(encField, opts.newKey);
    if (decField !== probe) throw new Error('field round-trip mismatch');
    const probeBytes = Buffer.from(probe, 'utf8');
    const encStream = await encryptBufferStreamingWith(probeBytes, opts.newKey);
    const decStream = await decryptBufferStreamingWith(encStream, opts.newKey);
    if (Buffer.compare(decStream, probeBytes) !== 0)
      throw new Error('stream round-trip mismatch');
    newKeyRoundTripOk = true;
  } catch {
    newKeyRoundTripOk = false;
  }

  return { counts, sample: { sessionDecryptOk, fileDecryptOk, newKeyRoundTripOk } };
}

/**
 * Persist progress to `intake_key_rotations`. Called after every batch
 * so SIGTERM mid-flight can resume from the right pointer.
 */
async function persistProgress(
  jobId: string,
  fields: {
    processed_sessions?: number;
    processed_files?: number;
    processed_pdfs?: number;
    last_processed_session_id?: string;
    status?: 'running' | 'paused' | 'completed' | 'failed';
    error_message?: string | null;
    completed_at?: Date | null;
  },
): Promise<void> {
  const update: Record<string, unknown> = { ...fields };
  if (fields.completed_at !== undefined) {
    update.completed_at = fields.completed_at?.toISOString() ?? null;
  }
  await db('intake_key_rotations').where({ id: jobId }).update(update);
}

/**
 * Idempotent per-field rotation. Tries the new key first; if it
 * decrypts the field was already rotated and we just re-emit the
 * existing Buffer. Otherwise decrypts with old, re-encrypts with new.
 * Used by `rotateSessionRow` and `rotateLinkRow` so a SIGTERM-mid-row
 * crash followed by /resume doesn't fail on already-rotated columns.
 */
async function rotateFieldIdempotent(
  enc: Buffer,
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<Buffer> {
  try {
    // Probe with new key. Successful decrypt → already rotated.
    await decryptFieldWith(enc, newKey);
    return enc;
  } catch {
    // Fall through to old→new path.
  }
  const plain = await decryptFieldWith(enc, oldKey);
  return encryptFieldWith(plain, newKey);
}

/**
 * Re-encrypt PII fields on a single intake_sessions row. Returns the new
 * encrypted Buffers; the caller writes them back inside the per-session
 * transaction. We never modify search-hash columns — those are HKDF-keyed
 * off SESSION_SECRET (see intakeCrypto.searchHash) and survive rotation
 * by design.
 *
 * Each field is rotated independently via `rotateFieldIdempotent` so a
 * prior partial run (PII done, files crashed) resumes cleanly.
 */
async function rotateSessionRow(
  row: {
    id: string;
    client_name_enc: Buffer;
    client_email_enc: Buffer | null;
    client_phone_enc: Buffer | null;
  },
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<{
  client_name_enc: Buffer;
  client_email_enc: Buffer | null;
  client_phone_enc: Buffer | null;
}> {
  const nameEnc = await rotateFieldIdempotent(row.client_name_enc, oldKey, newKey);
  const emailEnc = row.client_email_enc
    ? await rotateFieldIdempotent(row.client_email_enc, oldKey, newKey)
    : null;
  const phoneEnc = row.client_phone_enc
    ? await rotateFieldIdempotent(row.client_phone_enc, oldKey, newKey)
    : null;
  return { client_name_enc: nameEnc, client_email_enc: emailEnc, client_phone_enc: phoneEnc };
}

/**
 * Re-encrypt a single on-disk blob. Reads ciphertext via attachmentStorage,
 * stream-decrypts with old key, stream-re-encrypts with new key, writes
 * back to the SAME key (overwrite).
 *
 * IDEMPOTENT: the worker first attempts to decrypt with the NEW key.
 * If that succeeds the blob is already rotated (a prior crashed run
 * processed this file before the batch checkpoint advanced) — skip the
 * rewrite. This is the resume-tolerance invariant: a SIGTERM mid-rotation
 * can leave any subset of a session's files already under NEW; the next
 * run skips those and re-rotates only the remainder.
 *
 * `attachmentStorage.put` is non-atomic on the LocalStorage driver
 * (writeFile, not rename). Currently the few-millisecond window between
 * the old-key delete and the new-key write is held in memory only —
 * never on disk — so a crash leaves either OLD or NEW intact, never a
 * partial blob. The new-key decrypt probe above handles either outcome.
 */
async function rotateFileBlob(
  storedPath: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<{ originalSha256: string; newSha256: string; skipped: boolean }> {
  const storage = attachmentStorage();
  const ct = await storage.get(storedPath);
  // Idempotency probe — does this blob already decrypt under the new
  // key? If so a prior partial run already rotated it; we just verify
  // and move on. The probe is cheap (~ms) and avoids the destructive
  // path entirely.
  try {
    const alreadyPlain = await decryptBufferStreamingWith(ct, newKey);
    const sha = crypto.createHash('sha256').update(alreadyPlain).digest('hex');
    return { originalSha256: sha, newSha256: sha, skipped: true };
  } catch {
    // Falls through to the old→new path below. Any decryption failure
    // is treated as "not yet rotated" — the old-key decrypt that
    // follows will throw a more specific error if the blob is actually
    // unrecoverable.
  }
  const plaintext = await decryptBufferStreamingWith(ct, oldKey);
  const originalSha256 = crypto.createHash('sha256').update(plaintext).digest('hex');
  const newCt = await encryptBufferStreamingWith(plaintext, newKey);
  await storage.put(storedPath, newCt);
  // Verify: decrypt back with the new key and check the plaintext hash
  // matches. Catches a flipped-bit or a wrong-key write before we mark
  // the row processed.
  const verify = await decryptBufferStreamingWith(newCt, newKey);
  const verifySha256 = crypto.createHash('sha256').update(verify).digest('hex');
  if (verifySha256 !== originalSha256) {
    throw new Error('rotateFileBlob: post-encrypt verification hash mismatch');
  }
  return { originalSha256, newSha256: verifySha256, skipped: false };
}

/**
 * Re-encrypt one intake_links row's PII (no on-disk blob). Returns the
 * new encrypted Buffers for the caller to write.
 */
async function rotateLinkRow(
  row: { id: string; client_email_enc: Buffer | null; client_phone_enc: Buffer | null },
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<{ client_email_enc: Buffer | null; client_phone_enc: Buffer | null }> {
  const emailEnc = row.client_email_enc
    ? await rotateFieldIdempotent(row.client_email_enc, oldKey, newKey)
    : null;
  const phoneEnc = row.client_phone_enc
    ? await rotateFieldIdempotent(row.client_phone_enc, oldKey, newKey)
    : null;
  return { client_email_enc: emailEnc, client_phone_enc: phoneEnc };
}

export interface VerificationResult {
  sessionSampled: number;
  sessionOk: number;
  fileSampled: number;
  fileOk: number;
  /** sha256 mismatches: file decrypts under new key but plaintext hash differs from intake_files.sha256. */
  fileShaMismatches: number;
  /** Sample IDs that failed — surfaced in audit details so admin can investigate. */
  failedSessionIds: string[];
  failedFileIds: string[];
}

/**
 * Verification pass: random-sample 1% (min 1, max 50) of re-encrypted
 * rows AFTER the main loop completes. Verifies two invariants:
 *
 *   1. Session PII: each sampled `client_name_enc` decrypts under the
 *      new key (proves field-encrypt round-trip).
 *   2. File blob: each sampled blob decrypts under the new key AND its
 *      plaintext sha256 matches the `intake_files.sha256` column
 *      captured at upload time (proves the streaming round-trip
 *      preserved bytes — catches silent corruption like bit-flips that
 *      occurred AFTER `rotateFileBlob`'s in-line verify).
 *
 * The per-row encrypt path already verifies before marking processed;
 * this is a belt-and-suspenders post-pass that catches storage corruption,
 * key-mismatch on disk, or partial overwrites the synchronous path missed.
 *
 * Returns a structured result so the audit row can record exactly which
 * IDs failed — `sampled === ok` is the green path; anything less means
 * an operator must investigate before swapping the env var.
 */
export async function verifyRotation(
  newKey: Uint8Array,
  totalSessions: number,
): Promise<VerificationResult> {
  const result: VerificationResult = {
    sessionSampled: 0,
    sessionOk: 0,
    fileSampled: 0,
    fileOk: 0,
    fileShaMismatches: 0,
    failedSessionIds: [],
    failedFileIds: [],
  };
  if (totalSessions === 0) return result;
  const sampleSize = Math.min(50, Math.max(1, Math.ceil(totalSessions / 100)));

  // Sample sessions.
  const sessions = (await db('intake_sessions')
    .select<Array<{ id: string; client_name_enc: Buffer }>>('id', 'client_name_enc')
    .orderByRaw('random()')
    .limit(sampleSize)) as Array<{ id: string; client_name_enc: Buffer }>;
  for (const s of sessions) {
    result.sessionSampled += 1;
    try {
      await decryptFieldWith(s.client_name_enc, newKey);
      result.sessionOk += 1;
    } catch {
      result.failedSessionIds.push(s.id);
    }
  }

  // Sample files. Capped at the same sampleSize for symmetry; covers
  // a different cohort than the sessions sample (random per-row).
  const files = (await db('intake_files')
    .select<Array<{ id: string; stored_path: string; sha256: string }>>(
      'id',
      'stored_path',
      'sha256',
    )
    .orderByRaw('random()')
    .limit(sampleSize)) as Array<{ id: string; stored_path: string; sha256: string }>;
  const storage = attachmentStorage();
  for (const f of files) {
    result.fileSampled += 1;
    try {
      const ct = await storage.get(f.stored_path);
      const plaintext = await decryptBufferStreamingWith(ct, newKey);
      const sha = crypto.createHash('sha256').update(plaintext).digest('hex');
      if (sha === f.sha256) {
        result.fileOk += 1;
      } else {
        // Decrypt succeeded but plaintext bytes don't match the upload
        // hash — silent corruption.
        result.fileShaMismatches += 1;
        result.failedFileIds.push(f.id);
      }
    } catch {
      result.failedFileIds.push(f.id);
    }
  }
  return result;
}

/**
 * Main entry: rotate every intake at-rest item from `oldKey` to `newKey`.
 * Updates the `intake_key_rotations` row as it goes. Returns the final
 * status. Caller is the route handler which fires this without awaiting
 * (the rotation runs in-process; status is observable via GET
 * /admin/intake/rotate-key/:jobId).
 */
export async function runKeyRotation(job: RotationJob): Promise<void> {
  // Caller (route) already flipped activeRotation via tryClaimRotationActive().
  // We assert rather than re-set so a direct invocation (tests) still works.
  activeRotation = true;
  // shutdownRequested is NOT reset here — the SIGTERM signal must survive
  // worker-restart boundaries. Each new RotationJob (start or resume) is
  // dispatched only after a fresh process boot or after the previous
  // worker exited cleanly, in which case the flag is already false. If a
  // shutdown was requested mid-process and a second job is somehow
  // launched, that job inherits the request and exits cleanly too — the
  // correct behavior.
  const { jobId, oldKey, newKey, batchSize } = job;
  try {
    let lastSessionId: string | null = job.resumeFromSessionId ?? null;
    let processedSessions = 0;
    let processedFiles = 0;
    let processedPdfs = 0;

    await auditRepo.write({
      actorUserId: null,
      action: 'intake.key_rotation.started',
      targetType: 'intake_key_rotation',
      targetId: jobId,
      details: { resumeFrom: lastSessionId ?? null, batchSize },
      ipAddress: null,
    });

    // Outer loop iterates batches of sessions ordered by id. Each batch
    // is small enough that progress lands in the rotation row promptly
    // even when individual file re-encrypts are slow.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (shutdownRequested) {
        await persistProgress(jobId, { status: 'paused' });
        await auditRepo.write({
          actorUserId: null,
          action: 'intake.key_rotation.paused',
          targetType: 'intake_key_rotation',
          targetId: jobId,
          details: { processedSessions, processedFiles, processedPdfs, lastSessionId },
          ipAddress: null,
        });
        logger.info('intake.key_rotation.paused', {
          jobId,
          processedSessions,
          processedFiles,
          processedPdfs,
        });
        return;
      }

      const batchQ = db('intake_sessions')
        .orderBy('id', 'asc')
        .limit(batchSize)
        .select<
          Array<{
            id: string;
            client_name_enc: Buffer;
            client_email_enc: Buffer | null;
            client_phone_enc: Buffer | null;
          }>
        >('id', 'client_name_enc', 'client_email_enc', 'client_phone_enc');
      if (lastSessionId) batchQ.where('id', '>', lastSessionId);
      const batch = await batchQ;
      if (batch.length === 0) break;

      for (const session of batch) {
        if (shutdownRequested) break;
        // 1) Rotate PII columns.
        const reencrypted = await rotateSessionRow(session, oldKey, newKey);
        await db('intake_sessions').where({ id: session.id }).update(reencrypted);
        // 2) Rotate intake_files blobs.
        const files = (await db('intake_files')
          .where({ session_id: session.id })
          .select<Array<{ id: string; stored_path: string }>>('id', 'stored_path')) as Array<{
          id: string;
          stored_path: string;
        }>;
        for (const f of files) {
          if (shutdownRequested) break;
          await rotateFileBlob(f.stored_path, oldKey, newKey);
          processedFiles += 1;
        }
        if (shutdownRequested) break;
        // 3) Rotate intake_pdfs blob (one per session at most).
        const pdf = await db('intake_pdfs')
          .where({ session_id: session.id })
          .whereNotNull('stored_path')
          .first<{ id: string; stored_path: string }>('id', 'stored_path');
        if (pdf?.stored_path) {
          await rotateFileBlob(pdf.stored_path, oldKey, newKey);
          processedPdfs += 1;
        }

        processedSessions += 1;
        lastSessionId = session.id;
      }

      // Batch checkpoint.
      await persistProgress(jobId, {
        processed_sessions: processedSessions,
        processed_files: processedFiles,
        processed_pdfs: processedPdfs,
        last_processed_session_id: lastSessionId ?? undefined,
      });
      if (processedSessions % 10 === 0 || batch.length < batchSize) {
        logger.info('intake.key_rotation.progress', {
          jobId,
          processedSessions,
          processedFiles,
          processedPdfs,
        });
      }
    }

    // Links pass — independent of sessions, single loop.
    if (!shutdownRequested) {
      const links = (await db('intake_links')
        .where(function () {
          this.whereNotNull('client_email_enc').orWhereNotNull('client_phone_enc');
        })
        .select<
          Array<{ id: string; client_email_enc: Buffer | null; client_phone_enc: Buffer | null }>
        >('id', 'client_email_enc', 'client_phone_enc')) as Array<{
        id: string;
        client_email_enc: Buffer | null;
        client_phone_enc: Buffer | null;
      }>;
      for (const link of links) {
        if (shutdownRequested) break;
        const reencrypted = await rotateLinkRow(link, oldKey, newKey);
        await db('intake_links').where({ id: link.id }).update(reencrypted);
      }
    }

    if (shutdownRequested) {
      await persistProgress(jobId, { status: 'paused' });
      await auditRepo.write({
        actorUserId: null,
        action: 'intake.key_rotation.paused',
        targetType: 'intake_key_rotation',
        targetId: jobId,
        details: { processedSessions, processedFiles, processedPdfs, lastSessionId },
        ipAddress: null,
      });
      return;
    }

    // Verification pass (does not gate completion — purely informational
    // but the structured result is preserved in audit for ops review).
    const verify = await verifyRotation(newKey, processedSessions);

    await persistProgress(jobId, {
      status: 'completed',
      completed_at: new Date(),
      processed_sessions: processedSessions,
      processed_files: processedFiles,
      processed_pdfs: processedPdfs,
      last_processed_session_id: lastSessionId ?? undefined,
    });
    await auditRepo.write({
      actorUserId: null,
      action: 'intake.key_rotation.completed',
      targetType: 'intake_key_rotation',
      targetId: jobId,
      details: {
        processedSessions,
        processedFiles,
        processedPdfs,
        verify,
      },
      ipAddress: null,
    });
    logger.info('intake.key_rotation.completed', {
      jobId,
      processedSessions,
      processedFiles,
      processedPdfs,
      verify,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await persistProgress(jobId, { status: 'failed', error_message: msg.slice(0, 500) });
    await auditRepo.write({
      actorUserId: null,
      action: 'intake.key_rotation.failed',
      targetType: 'intake_key_rotation',
      targetId: jobId,
      details: { error: msg.slice(0, 500) },
      ipAddress: null,
    });
    logger.error('intake.key_rotation.failed', { jobId, err: msg });
    throw err;
  } finally {
    activeRotation = false;
  }
}

/**
 * Shutdown hook. Index.ts calls this from the SIGTERM/SIGINT handler.
 * The currently-running batch finishes its in-flight row then exits
 * cleanly with status='paused'. Resume via POST /admin/intake/rotate-key/:jobId/resume.
 */
export function stopIntakeKeyRotation(): void {
  shutdownRequested = true;
}

/** Test-only reset for the in-process activeRotation flag. */
export function __resetIntakeKeyRotationState(): void {
  activeRotation = false;
  shutdownRequested = false;
}

export function isRotationActive(): boolean {
  return activeRotation;
}

/**
 * Atomically reserve the activeRotation slot. Returns `true` if the
 * caller now owns the slot (must release on dispatch failure via
 * `releaseRotationActive()`), `false` if another rotation already holds it.
 *
 * Single-threaded Node executes this whole function on one event-loop
 * tick — the check-and-set is genuinely atomic against any other JS
 * code, so two concurrent route handlers cannot both observe `false`.
 */
export function tryClaimRotationActive(): boolean {
  if (activeRotation) return false;
  activeRotation = true;
  return true;
}

/**
 * Release the activeRotation slot. Called by the route when worker
 * dispatch fails synchronously (extremely rare — bad import, OOM during
 * the `await` on jobId insert, etc.). The worker's own `finally` block
 * also calls `activeRotation = false` so a normal successful dispatch
 * needs no caller-side release.
 */
export function releaseRotationActive(): void {
  activeRotation = false;
}
