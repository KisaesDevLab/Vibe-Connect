// Phase 26 — Vault upload finalization.
//
// Called from tusServer.ts when a vault upload's last byte lands. Owns the
// scan → store → row insert → realtime publish → audit pipeline, exactly
// mirroring portalUpload.ts but with vault_files semantics.
//
// Fail-closed contract:
//   ClamAV verdict 'infected' → 422, no row, no publish, audit logs scan_failed
//   ClamAV verdict 'error'    → 503, no row, no publish, audit logs scan_failed
//   ClamAV verdict 'clean'    → row inserted with scan_status='clean', publish, audit
//
// CRYPTO: ciphertext throughout. The buffer is whatever the client tus-uploaded
// (already client-encrypted under a per-file key wrapped to the zone key).
import { randomBytes } from 'node:crypto';
import { attachmentStorage } from './attachmentStorage.js';
import { scanBuffer } from './clamav.js';
import { auditRepo } from '../repositories/audit.js';
import { clientVaultsRepo, vaultFilesRepo, type VaultUploadRow } from '../repositories/vaults.js';
import { publish } from '../realtime/pgFanout.js';
import { logger } from '../logger.js';
import { TusFinalizeError } from './tusServer.js';
import { VAULT_AUDIT_ACTIONS } from './vaultService.js';

export interface TusFinishContext {
  upload: VaultUploadRow;
  metadata: Record<string, string>;
  ciphertextBuffer: Buffer;
  /** Audit actor — exactly one set. */
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
}

const ALLOWED_MIMES_VAULT_STAFF = new Set<string>([
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
  // Phase 26: QuickBooks bookkeeping artefacts.
  'application/vnd.intuit.quickbooks',
  'application/x-qbb',
]);

const ALLOWED_MIMES_VAULT_PORTAL = new Set<string>([
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

export function isAllowedVaultMime(mime: string, isPortal: boolean): boolean {
  return (isPortal ? ALLOWED_MIMES_VAULT_PORTAL : ALLOWED_MIMES_VAULT_STAFF).has(mime);
}

export async function onTusUploadFinish(ctx: TusFinishContext): Promise<{ fileId: string }> {
  const { upload, metadata, ciphertextBuffer } = ctx;

  const filenameCiphertext = metadata.filenameCiphertext;
  const wrappedFileKeyB64 = metadata.wrappedFileKey;
  const mimeType = metadata.mimeType ?? 'application/octet-stream';
  const contentKeyVersion = Number(metadata.contentKeyVersion ?? '1');
  if (!filenameCiphertext) {
    throw new TusFinalizeError(400, 'missing_filename_ciphertext');
  }
  if (!wrappedFileKeyB64) {
    throw new TusFinalizeError(400, 'missing_wrapped_file_key');
  }
  if (!Number.isInteger(contentKeyVersion) || contentKeyVersion < 1) {
    throw new TusFinalizeError(400, 'invalid_content_key_version');
  }

  // Scan ciphertext bytes. (We deliberately scan ciphertext — same posture
  // as message attachments. ClamAV only flags structural patterns it
  // recognises in the encoded stream, not file contents.)
  const scan = await scanBuffer(ciphertextBuffer);
  if (scan.status === 'infected') {
    await auditRepo.write({
      actorUserId: ctx.actorUserId,
      actorExternalIdentityId: ctx.actorExternalIdentityId,
      action: VAULT_AUDIT_ACTIONS.fileScanFailed,
      targetType: 'vault',
      targetId: upload.vault_id,
      details: { reason: 'infected', signature: scan.signature, uploadId: upload.upload_url_id },
    });
    throw new TusFinalizeError(422, `infected:${scan.signature}`);
  }
  if (scan.status === 'error') {
    await auditRepo.write({
      actorUserId: ctx.actorUserId,
      actorExternalIdentityId: ctx.actorExternalIdentityId,
      action: VAULT_AUDIT_ACTIONS.fileScanFailed,
      targetType: 'vault',
      targetId: upload.vault_id,
      details: { reason: 'scan_error', detail: scan.message, uploadId: upload.upload_url_id },
    });
    throw new TusFinalizeError(503, `scan_error:${scan.message}`);
  }

  // Store ciphertext on the appliance volume / S3.
  const storageKey = `vault-${upload.vault_id}-${upload.zone}-${Date.now()}-${randomBytes(8).toString('hex')}.bin`;
  let storedPath: string;
  try {
    storedPath = await attachmentStorage().put(storageKey, ciphertextBuffer);
  } catch (err) {
    logger.error('vault_storage_put_failed', { err: String(err), uploadId: upload.upload_url_id });
    throw new TusFinalizeError(500, 'storage_put_failed');
  }

  // Insert vault_files row.
  const wrappedFileKey = Buffer.from(wrappedFileKeyB64, 'base64');
  const file = await vaultFilesRepo.insert({
    vault_id: upload.vault_id,
    folder_id: upload.folder_id,
    zone: upload.zone,
    filename_ciphertext: filenameCiphertext,
    mime_type: mimeType,
    size_bytes: Number(upload.expected_size),
    storage_path: storedPath,
    wrapped_file_key: wrappedFileKey,
    content_key_version: contentKeyVersion,
    envelope_format: 'vault-zone-key-v1',
    scan_status: 'clean',
    uploaded_by_user_id: ctx.actorUserId,
    uploaded_by_external_identity_id: ctx.actorExternalIdentityId,
  });

  await auditRepo.write({
    actorUserId: ctx.actorUserId,
    actorExternalIdentityId: ctx.actorExternalIdentityId,
    action: VAULT_AUDIT_ACTIONS.fileUploaded,
    targetType: 'vault_file',
    targetId: file.id,
    details: {
      vaultId: upload.vault_id,
      zone: upload.zone,
      folderId: upload.folder_id,
      sizeBytes: Number(upload.expected_size),
      mimeType,
    },
  });

  // Resolve external_identity for the realtime payload — staff dashboards
  // filter on this to know which client's vault changed.
  const vault = await clientVaultsRepo.byId(upload.vault_id);
  await publish({
    type: 'vault:file-uploaded',
    vaultId: upload.vault_id,
    externalIdentityId: vault?.external_identity_id ?? '',
    fileId: file.id,
    zone: upload.zone,
    actorUserId: ctx.actorUserId,
    actorExternalIdentityId: ctx.actorExternalIdentityId,
  });

  return { fileId: file.id };
}
