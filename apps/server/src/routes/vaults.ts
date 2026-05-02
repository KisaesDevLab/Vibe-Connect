// Phase 26 — Staff-facing Client Vault routes.
//
// Mounted from app.ts under root: every endpoint paths in as
// `/clients/:id/vault/...` where `:id` is the external_identity_id.
//
// Concerns this router owns:
//   - list / folder CRUD / file metadata CRUD / file download
//   - init a tus upload (POST .../files returns Location for tus tail)
//   - rotate zone keys / add zone recipients
//
// The tus protocol tail (HEAD/PATCH/DELETE on /uploads/:id) lives in
// routes/vaultsUpload.ts. Emergency decrypt + template apply land in 26.9.
//
// Authn: every endpoint requires staff session (requireAuth). Authz lives
// inside vaultService.assertStaffCanAccessVault — staff need at least one
// non-removed conversation membership against the client.
import { Router, type Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { requireVaultEnabled } from '../middleware/vaultEnabled.js';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { ensureBackupFresh } from '../services/backupGate.js';
import {
  addRecipientSchema,
  addZoneRecipients,
  assertStaffCanAccessVault,
  createFolder,
  createFolderSchema,
  deleteFile,
  deleteFolder,
  ensureVaultForExternalIdentity,
  listVaultZone,
  patchFile,
  patchFileSchema,
  patchFolder,
  patchFolderSchema,
  presentFile,
  presentFolder,
  presentKeyBundle,
  presentVault,
  recipientIdsForCaller,
  rotateKeysSchema,
  rotateZoneKey,
  VaultServiceError,
  VAULT_AUDIT_ACTIONS,
} from '../services/vaultService.js';
import { tusCreate, tusOptions, parseUploadMetadata } from '../services/tusServer.js';
import { isAllowedVaultMime } from '../services/vaultUploadService.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { vaultFilesRepo } from '../repositories/vaults.js';
import { auditRepo } from '../repositories/audit.js';

export const vaultsRouter = Router();

vaultsRouter.use(requireAuth, requireVaultEnabled);

// ---------- Error translation ----------

function statusForVaultError(err: VaultServiceError): number {
  switch (err.code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'zone_violation':
    case 'invalid_state':
      return 409;
    case 'stepup_required':
      return 403;
    case 'vault_disabled':
      return 403;
    case 'client_delete_blocked':
      return 403;
    default:
      return 400;
  }
}

function sendVaultError(res: ExpressResponse, err: unknown): void {
  if (err instanceof VaultServiceError) {
    res.status(statusForVaultError(err)).json({ error: err.code, detail: err.message });
    return;
  }
  throw err;
}

// ---------- Vault listing ----------

vaultsRouter.get(
  '/clients/:id/vault',
  asyncHandler(async (req, res) => {
    const externalIdentityId = req.params.id!;
    const userId = req.session.userId!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const vaultRow = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    const callerRecipientIds = await recipientIdsForCaller({ userId });
    const [shared, staffOnly] = await Promise.all([
      listVaultZone({
        vaultId: vaultRow.id,
        zone: 'shared',
        callerRecipientIds,
      }),
      listVaultZone({
        vaultId: vaultRow.id,
        zone: 'staff_only',
        callerRecipientIds,
      }),
    ]);
    res.json({
      vault: presentVault(vaultRow),
      folders: [...shared.folders, ...staffOnly.folders].map(presentFolder),
      files: [...shared.files, ...staffOnly.files].map(presentFile),
      keys: [...shared.keys, ...staffOnly.keys].map(presentKeyBundle),
    });
  }),
);

// ---------- Folder CRUD ----------

vaultsRouter.post(
  '/clients/:id/vault/folders',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const parsed = createFolderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      const folder = await createFolder({
        actorUserId: userId,
        vaultId: vault.id,
        zone: parsed.data.zone,
        parentFolderId: parsed.data.parentFolderId ?? null,
        nameCiphertext: parsed.data.nameCiphertext,
        contentKeyVersion: parsed.data.contentKeyVersion,
        sortOrder: parsed.data.sortOrder,
      });
      res.status(201).json({ folder: presentFolder(folder) });
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

vaultsRouter.patch(
  '/clients/:id/vault/folders/:fid',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const parsed = patchFolderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      const folder = await patchFolder({
        actorUserId: userId,
        vaultId: vault.id,
        folderId: req.params.fid!,
        patch: parsed.data,
      });
      res.json({ folder: presentFolder(folder) });
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

vaultsRouter.delete(
  '/clients/:id/vault/folders/:fid',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      await deleteFolder({
        actorUserId: userId,
        vaultId: vault.id,
        folderId: req.params.fid!,
      });
      res.status(204).end();
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

// ---------- File metadata + download ----------

vaultsRouter.patch(
  '/clients/:id/vault/files/:fid',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const parsed = patchFileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      const file = await patchFile({
        actorUserId: userId,
        actorExternalIdentityId: null,
        vaultId: vault.id,
        fileId: req.params.fid!,
        patch: parsed.data,
      });
      res.json({ file: presentFile(file) });
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

vaultsRouter.delete(
  '/clients/:id/vault/files/:fid',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      await deleteFile({
        actorUserId: userId,
        actorExternalIdentityId: null,
        vaultId: vault.id,
        fileId: req.params.fid!,
      });
      res.status(204).end();
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

vaultsRouter.get(
  '/clients/:id/vault/files/:fid',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    const row = await vaultFilesRepo.byId(req.params.fid!);
    if (!row || row.deleted_at) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // IDOR guard: file must live in the vault for the URL's :id. Without
    // this, any staff with access to one client's vault could fetch any
    // other client's vault file by passing its UUID.
    if (row.vault_id !== vault.id) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.scan_status !== 'clean') {
      res.status(409).json({ error: 'scan_not_clean', scanStatus: row.scan_status });
      return;
    }
    let buf: Buffer;
    try {
      buf = await attachmentStorage().get(row.storage_path);
    } catch (err) {
      logger.error('vault_file_get_failed', { id: row.id, err: String(err) });
      res.status(500).json({ error: 'storage_get_failed' });
      return;
    }
    await auditRepo.write({
      actorUserId: userId,
      action: VAULT_AUDIT_ACTIONS.fileDownloaded,
      targetType: 'vault_file',
      targetId: row.id,
      details: { vaultId: row.vault_id, zone: row.zone },
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.status(200).end(buf);
  }),
);

vaultsRouter.post(
  '/clients/:id/vault/files/:fid/versions',
  asyncHandler(async (_req, res) => {
    // v2 territory — declared in shared-types but unimplemented in v1 to keep
    // the upload pipeline single-purpose. Returning 501 lets the staff UI
    // surface "version history coming in v2" rather than failing silently.
    res.status(501).json({ error: 'not_implemented', detail: 'file_versioning_v2' });
  }),
);

// ---------- tus upload init ----------

vaultsRouter.options(
  '/clients/:id/vault/uploads',
  asyncHandler(async (_req, res) => {
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_max_file_bytes');
    tusOptions(_req, res, Number(settings?.vault_max_file_bytes ?? 262144000));
  }),
);

vaultsRouter.post(
  '/clients/:id/vault/uploads',
  asyncHandler(async (req, res) => {
    if (!(await ensureBackupFresh(res))) return;
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const metadata = parseUploadMetadata(req.header('Upload-Metadata'));
    if (!metadata) {
      res.status(400).json({ error: 'invalid_upload_metadata' });
      return;
    }
    const zone = metadata.zone === 'staff_only' ? 'staff_only' : 'shared';
    if (metadata.zone !== zone && metadata.zone !== 'shared') {
      res.status(400).json({ error: 'bad_zone' });
      return;
    }
    const mimeType = metadata.mimeType ?? 'application/octet-stream';
    if (!isAllowedVaultMime(mimeType, false)) {
      res.status(415).json({ error: 'mime_not_allowed', mimeType });
      return;
    }
    const folderId = metadata.folderId || null;
    // Verify folderId, if provided, belongs to this vault and zone — prevent
    // cross-vault folder reference attacks.
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    if (folderId) {
      const folder = await db('vault_folders').where({ id: folderId }).first();
      if (!folder || folder.vault_id !== vault.id || folder.zone !== zone || folder.deleted_at) {
        res.status(400).json({ error: 'invalid_folder' });
        return;
      }
    }
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_max_file_bytes');
    const maxBytes = Number(settings?.vault_max_file_bytes ?? 262144000);
    await tusCreate(
      req,
      res,
      {
        auth: { userId, externalIdentityId: null },
        vaultId: vault.id,
        zone,
        folderId,
        expectedSize: Number(req.header('Upload-Length')),
        metadata,
        uploadUrlPrefix: `/clients/${externalIdentityId}/vault/uploads`,
      },
      maxBytes,
    );
  }),
);

// ---------- Zone key rotation ----------

vaultsRouter.post(
  '/clients/:id/vault/rotate-keys',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const parsed = rotateKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      const row = await rotateZoneKey({
        actorUserId: userId,
        vaultId: vault.id,
        zone: parsed.data.zone,
        rotationVersion: parsed.data.rotationVersion,
        wrappedKeys: parsed.data.wrappedKeys,
      });
      res.status(201).json({ key: presentKeyBundle(row) });
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

vaultsRouter.post(
  '/clients/:id/vault/recipients',
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const parsed = addRecipientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    try {
      const result = await addZoneRecipients({
        actorUserId: userId,
        vaultId: vault.id,
        zone: parsed.data.zone,
        added: parsed.data.added,
      });
      res.json(result);
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);

// ---------- Emergency decrypt (recovery-phrase-gated) ----------
//
// The partner provides the recovery phrase; the staff client derives the
// firm recovery secret key locally and posts a request that says "I have
// it; give me everything I need to bundle the vault export." Server returns
// every wrapped_keys entry keyed at `firm:recovery` plus every file row so
// the client can sequentially fetch ciphertext, decrypt, and stream into a
// zip. The unwrap itself happens client-side.
//
// Requires admin (recovery is a partner-level operation). Audits the export
// with the actor's user id and the vault id; the ip address tag from
// auditRepo.write() lets compliance reviews tie the export to a session.
import { requireAdmin } from '../middleware/auth.js';
vaultsRouter.post(
  '/clients/:id/vault/emergency-decrypt',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = req.session.userId!;
    const externalIdentityId = req.params.id!;
    try {
      await assertStaffCanAccessVault(userId, externalIdentityId);
    } catch (err) {
      return sendVaultError(res, err);
    }
    const vault = await ensureVaultForExternalIdentity(externalIdentityId, userId);
    const allKeys = await db('vault_keys')
      .where({ vault_id: vault.id })
      .orderBy([{ column: 'zone' }, { column: 'rotation_version' }]);
    const recoveryBundles = (
      allKeys as Array<{
        id: string;
        vault_id: string;
        zone: 'shared' | 'staff_only';
        rotation_version: number;
        wrapped_keys: Record<string, string>;
      }>
    )
      .map((k) => ({
        zone: k.zone,
        rotationVersion: k.rotation_version,
        wrappedRecoveryKey: k.wrapped_keys?.['firm:recovery'] ?? null,
      }))
      .filter((b) => b.wrappedRecoveryKey !== null);
    const files = await db('vault_files')
      .where({ vault_id: vault.id })
      .whereNull('deleted_at')
      .orderBy('uploaded_at', 'desc');
    await auditRepo.write({
      actorUserId: userId,
      action: VAULT_AUDIT_ACTIONS.emergencyDecrypted,
      targetType: 'vault',
      targetId: vault.id,
      details: {
        externalIdentityId,
        zonesUnlocked: recoveryBundles.map((b) => `${b.zone}@${b.rotationVersion}`),
        fileCount: files.length,
      },
      ipAddress: req.ip ?? null,
    });
    res.json({
      vaultId: vault.id,
      recoveryBundles,
      files: files.map((f) => ({
        id: f.id,
        zone: f.zone,
        folderId: f.folder_id,
        filenameCiphertext: f.filename_ciphertext,
        mimeType: f.mime_type,
        sizeBytes: Number(f.size_bytes),
        wrappedFileKey: Buffer.from(f.wrapped_file_key).toString('base64'),
        contentKeyVersion: f.content_key_version,
        envelopeFormat: f.envelope_format,
        uploadedAt: f.uploaded_at,
        // ciphertext path: client GETs /clients/:id/vault/files/:fid as usual.
      })),
    });
  }),
);

// Suppress unused-import lints for items reserved for the tail router.
void z;
