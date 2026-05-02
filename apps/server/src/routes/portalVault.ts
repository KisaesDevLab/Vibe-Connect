// Phase 26 — Portal-side Client Vault routes.
//
// Mounts under `/portal/vault` from app.ts. Shared zone ONLY — the
// staff_only zone is invisible: no UI affordance, no count, no hint, and
// the repository layer refuses to emit staff_only key bundles to a
// `client:*` recipient regardless of caller.
//
// Step-up gate: when `external_identity.verification_required` is set and
// `session.verified_until` is null or expired, every endpoint either:
//   - returns 200 with `stepupRequired: true` and no payload (listing,
//     vault metadata)
//   - returns 403 with `stepup_required` (uploads, downloads)
// Mirrors the existing portalConversations.ts gate, audit string included.
import { Router, type Request, type Response as ExpressResponse } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { checkVaultEnabledSoft } from '../middleware/vaultEnabled.js';
import { db } from '../db/knex.js';
import { logger } from '../logger.js';
import { auditRepo } from '../repositories/audit.js';
import { ensureBackupFresh } from '../services/backupGate.js';
import {
  clientVaultsRepo,
  vaultFilesRepo,
} from '../repositories/vaults.js';
import {
  deleteFile,
  ensureVaultForExternalIdentity,
  listVaultZone,
  presentFile,
  presentFolder,
  presentKeyBundle,
  presentVault,
  recipientIdsForCaller,
  VaultServiceError,
  VAULT_AUDIT_ACTIONS,
} from '../services/vaultService.js';
import { tusCreate, tusOptions, parseUploadMetadata } from '../services/tusServer.js';
import { isAllowedVaultMime } from '../services/vaultUploadService.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { loadSessionFromCookie } from './portal.js';

export const portalVaultRouter = Router();

interface PortalSessionAttached {
  clientSession: {
    id: string;
    external_identity_id: string;
    verified_until: string | null;
  };
  vaultDisabled?: boolean;
}

portalVaultRouter.use(
  asyncHandler(async (req, res, next) => {
    const session = await loadSessionFromCookie(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as Request & PortalSessionAttached).clientSession = session;
    next();
  }),
  checkVaultEnabledSoft,
);

function getSession(req: Request): PortalSessionAttached['clientSession'] {
  return (req as Request & PortalSessionAttached).clientSession;
}

function isVaultDisabled(req: Request): boolean {
  return Boolean((req as Request & PortalSessionAttached).vaultDisabled);
}

async function checkStepup(externalIdentityId: string, verifiedUntil: string | null): Promise<{
  stepupRequired: boolean;
  hasLast4Hash: boolean;
  verificationRequired: boolean;
}> {
  const identity = await db('external_identities').where({ id: externalIdentityId }).first();
  const verificationRequired = Boolean(identity?.verification_required);
  const hasLast4Hash = Boolean(identity?.verification_last4_hash);
  const stepupRequired =
    verificationRequired &&
    hasLast4Hash &&
    (!verifiedUntil || new Date(verifiedUntil) < new Date());
  return { stepupRequired, hasLast4Hash, verificationRequired };
}

function sendVaultError(res: ExpressResponse, err: unknown): void {
  if (err instanceof VaultServiceError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'forbidden' || err.code === 'client_delete_blocked'
          ? 403
          : 409;
    res.status(status).json({ error: err.code, detail: err.message });
    return;
  }
  throw err;
}

// ---------- Vault listing (Shared zone only) ----------

portalVaultRouter.get(
  '/portal/vault',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.json({ vaultDisabled: true, vault: null, folders: [], files: [], keys: [] });
      return;
    }
    const session = getSession(req);
    const { stepupRequired } = await checkStepup(
      session.external_identity_id,
      session.verified_until,
    );
    const vaultRow = await ensureVaultForExternalIdentity(session.external_identity_id, null);
    if (stepupRequired) {
      await auditRepo.write({
        actorExternalIdentityId: session.external_identity_id,
        action: VAULT_AUDIT_ACTIONS.portalKeyWithheldStepup,
        targetType: 'vault',
        targetId: vaultRow.id,
        details: { reason: 'verification_required' },
      });
      res.json({
        stepupRequired: true,
        vault: presentVault(vaultRow),
        folders: [],
        files: [],
        keys: [],
      });
      return;
    }
    const callerRecipientIds = await recipientIdsForCaller({
      externalIdentityId: session.external_identity_id,
      sessionId: session.id,
    });
    const shared = await listVaultZone({
      vaultId: vaultRow.id,
      zone: 'shared',
      callerRecipientIds,
    });
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
      action: 'portal.vault_viewed',
      targetType: 'vault',
      targetId: vaultRow.id,
    });
    res.json({
      stepupRequired: false,
      vault: presentVault(vaultRow),
      folders: shared.folders.map(presentFolder),
      files: shared.files.map(presentFile),
      keys: shared.keys.map(presentKeyBundle),
    });
  }),
);

// ---------- Init tus upload (Shared zone only, step-up gated) ----------

portalVaultRouter.options(
  '/portal/vault/uploads',
  asyncHandler(async (req, res) => {
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_max_file_bytes');
    tusOptions(req, res, Number(settings?.vault_max_file_bytes ?? 262144000));
  }),
);

portalVaultRouter.post(
  '/portal/vault/uploads',
  asyncHandler(async (req, res) => {
    if (!(await ensureBackupFresh(res))) return;
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    const session = getSession(req);
    const { stepupRequired } = await checkStepup(
      session.external_identity_id,
      session.verified_until,
    );
    if (stepupRequired) {
      res.status(403).json({ error: 'stepup_required' });
      return;
    }
    const metadata = parseUploadMetadata(req.header('Upload-Metadata'));
    if (!metadata) {
      res.status(400).json({ error: 'invalid_upload_metadata' });
      return;
    }
    // Portal can only upload to Shared zone. Hard-pin and ignore client claim.
    if (metadata.zone && metadata.zone !== 'shared') {
      res.status(403).json({ error: 'zone_forbidden' });
      return;
    }
    const mimeType = metadata.mimeType ?? 'application/octet-stream';
    if (!isAllowedVaultMime(mimeType, true)) {
      res.status(415).json({ error: 'mime_not_allowed', mimeType });
      return;
    }
    const folderId = metadata.folderId || null;
    const vault = await ensureVaultForExternalIdentity(session.external_identity_id, null);
    if (folderId) {
      const folder = await db('vault_folders').where({ id: folderId }).first();
      if (
        !folder ||
        folder.vault_id !== vault.id ||
        folder.zone !== 'shared' ||
        folder.deleted_at
      ) {
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
        auth: { userId: null, externalIdentityId: session.external_identity_id },
        vaultId: vault.id,
        zone: 'shared',
        folderId,
        expectedSize: Number(req.header('Upload-Length')),
        metadata: { ...metadata, zone: 'shared' },
        uploadUrlPrefix: `/portal/vault/uploads`,
      },
      maxBytes,
    );
  }),
);

// ---------- Stream a Shared-zone ciphertext file ----------

portalVaultRouter.get(
  '/portal/vault/files/:fid',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    const session = getSession(req);
    const { stepupRequired } = await checkStepup(
      session.external_identity_id,
      session.verified_until,
    );
    if (stepupRequired) {
      res.status(403).json({ error: 'stepup_required' });
      return;
    }
    const row = await vaultFilesRepo.byId(req.params.fid!);
    if (!row || row.deleted_at) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Portal callers must never see staff_only files. The vault-by-eid lookup
    // is the second guard — a stolen UUID for a staff_only file from a leaked
    // staff log can't be used to download.
    if (row.zone !== 'shared') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const vault = await clientVaultsRepo.byId(row.vault_id);
    if (!vault || vault.external_identity_id !== session.external_identity_id) {
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
      logger.error('portal_vault_file_get_failed', { id: row.id, err: String(err) });
      res.status(500).json({ error: 'storage_get_failed' });
      return;
    }
    await auditRepo.write({
      actorExternalIdentityId: session.external_identity_id,
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

// ---------- Soft-delete a client's own upload ----------

portalVaultRouter.delete(
  '/portal/vault/files/:fid',
  asyncHandler(async (req, res) => {
    if (isVaultDisabled(req)) {
      res.status(403).json({ error: 'vault_disabled' });
      return;
    }
    const session = getSession(req);
    const { stepupRequired } = await checkStepup(
      session.external_identity_id,
      session.verified_until,
    );
    if (stepupRequired) {
      res.status(403).json({ error: 'stepup_required' });
      return;
    }
    const settings = await db('firm_settings').where({ id: 1 }).first('vault_client_delete');
    const allow = settings?.vault_client_delete !== false;
    const vault = await ensureVaultForExternalIdentity(session.external_identity_id, null);
    try {
      await deleteFile({
        actorUserId: null,
        actorExternalIdentityId: session.external_identity_id,
        vaultId: vault.id,
        fileId: req.params.fid!,
        clientCanDelete: allow,
      });
      res.status(204).end();
    } catch (err) {
      sendVaultError(res, err);
    }
  }),
);
