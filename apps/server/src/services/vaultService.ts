// Phase 26 — Client Vault service layer.
//
// Pure-ish business logic around the vault repositories. No HTTP and no
// inline Socket.io emits — the route layer (26.4 / 26.5) translates
// VaultServiceError into HTTP status codes; realtime events go through
// publish() so multi-instance deployments fan out via pg LISTEN/NOTIFY.
//
// Hard zone-separation invariant lives in repositories/vaults.ts. This
// service adds policy on top: who can request which zone, when step-up
// gates apply, what audit action fires.
//
// CRYPTO: server stores ciphertext only. Zone key wrapping happens
// client-side; the service stores wrapped_keys exactly as the client
// uploaded them, with the additional invariant that staff_only never
// gains a `client:*` recipient (enforced at vaultKeysRepo).
import type { Knex } from 'knex';
import { z } from 'zod';
import type {
  ClientVault,
  VaultFile,
  VaultFolder,
  VaultKeyBundle,
  VaultZone,
} from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';
import { auditRepo } from '../repositories/audit.js';
import {
  clientVaultsRepo,
  vaultFilesRepo,
  vaultFoldersRepo,
  vaultKeysRepo,
  type ClientVaultRow,
  type VaultFileRow,
  type VaultFolderRow,
  type VaultKeyRow,
} from '../repositories/vaults.js';
import { publish } from '../realtime/pgFanout.js';

// ---------- Recipient ID helpers ----------
// Mirror the format from routes/conversations.ts so wrapped_keys lookups are
// uniform across conversation_keys + vault_keys. Anything that needs to
// identify a wrap target should call these helpers, never inline the format.

export function recipientIdForUserDevice(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export function recipientIdForClientSession(externalIdentityId: string, sessionId: string): string {
  return `client:${externalIdentityId}:session:${sessionId}`;
}

export function recipientIdForClientInvite(externalIdentityId: string): string {
  return `client:${externalIdentityId}:invite`;
}

export const RECIPIENT_FIRM_RECOVERY = 'firm:recovery';

export function isClientRecipientId(recipientId: string): boolean {
  return recipientId.startsWith('client:');
}

// ---------- Zod schemas (re-used by routes) ----------

export const zoneSchema = z.enum(['shared', 'staff_only']);

const B64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
const b64String = z
  .string()
  .min(1)
  .max(65536)
  .regex(B64_REGEX, 'must be RFC4648 base64');
// Folder names are short; cap at 4 KiB ciphertext envelope.
const b64Name = z.string().min(1).max(4096).regex(B64_REGEX, 'must be RFC4648 base64');

export const wrappedKeyMapSchema = z.record(z.string().min(1).max(256), b64String);

export const rotateKeysSchema = z.object({
  zone: zoneSchema,
  rotationVersion: z.number().int().min(1),
  wrappedKeys: wrappedKeyMapSchema,
});

export const addRecipientSchema = z.object({
  zone: zoneSchema,
  rotationVersion: z.number().int().min(1),
  added: wrappedKeyMapSchema,
});

export const createFolderSchema = z.object({
  zone: zoneSchema,
  parentFolderId: z.string().uuid().nullable().optional(),
  nameCiphertext: b64Name,
  contentKeyVersion: z.number().int().min(1),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const patchFolderSchema = z.object({
  nameCiphertext: b64Name.optional(),
  contentKeyVersion: z.number().int().min(1).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  parentFolderId: z.string().uuid().nullable().optional(),
});

export const patchFileSchema = z.object({
  filenameCiphertext: b64Name.optional(),
  contentKeyVersion: z.number().int().min(1).optional(),
  folderId: z.string().uuid().nullable().optional(),
  retentionExpiresAt: z.string().datetime().nullable().optional(),
});

// ---------- Errors ----------

export type VaultServiceErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'zone_violation'
  | 'invalid_state'
  | 'stepup_required'
  | 'vault_disabled'
  | 'client_delete_blocked';

export class VaultServiceError extends Error {
  constructor(public readonly code: VaultServiceErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VaultServiceError';
  }
}

// ---------- Audit action constants ----------

export const VAULT_AUDIT_ACTIONS = {
  vaultCreated: 'vault.created',
  zoneRekeyed: 'vault.zone_rekeyed',
  zoneRecipientAdded: 'vault.zone_recipient_added',
  folderCreated: 'vault.folder_created',
  folderRenamed: 'vault.folder_renamed',
  folderMoved: 'vault.folder_moved',
  folderDeleted: 'vault.folder_deleted',
  folderRestored: 'vault.folder_restored',
  fileUploaded: 'vault.file_uploaded',
  fileDownloaded: 'vault.file_downloaded',
  fileRenamed: 'vault.file_renamed',
  fileMoved: 'vault.file_moved',
  fileDeleted: 'vault.file_deleted',
  fileRestored: 'vault.file_restored',
  fileScanFailed: 'vault.file_scan_failed',
  zoneCryptoShredded: 'vault.zone_crypto_shredded',
  emergencyDecrypted: 'vault.emergency_decrypted',
  exportRecoveryPhrase: 'vault.export_recovery_phrase',
  clientDeleteBlocked: 'vault.client_delete_blocked',
  portalKeyWithheldStepup: 'portal.vaultkey_withheld_stepup',
} as const;

// ---------- Presenters ----------

export function presentVault(row: ClientVaultRow): ClientVault {
  return {
    id: row.id,
    externalIdentityId: row.external_identity_id,
    settings: row.settings ?? {},
    createdAt: row.created_at,
  };
}

export function presentFolder(row: VaultFolderRow): VaultFolder {
  return {
    id: row.id,
    vaultId: row.vault_id,
    parentFolderId: row.parent_folder_id,
    zone: row.zone,
    nameCiphertext: row.name_ciphertext,
    contentKeyVersion: row.content_key_version,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function presentFile(row: VaultFileRow): VaultFile {
  return {
    id: row.id,
    vaultId: row.vault_id,
    folderId: row.folder_id,
    zone: row.zone,
    filenameCiphertext: row.filename_ciphertext,
    mimeType: row.mime_type,
    sizeBytes: typeof row.size_bytes === 'string' ? Number(row.size_bytes) : row.size_bytes,
    wrappedFileKey: Buffer.from(row.wrapped_file_key).toString('base64'),
    contentKeyVersion: row.content_key_version,
    envelopeFormat: row.envelope_format,
    scanStatus: row.scan_status,
    version: row.version,
    priorVersionId: row.prior_version_id,
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedByExternalIdentityId: row.uploaded_by_external_identity_id,
    uploadedAt: row.uploaded_at,
    retentionExpiresAt: row.retention_expires_at,
    deletedAt: row.deleted_at,
  };
}

export function presentKeyBundle(row: VaultKeyRow): VaultKeyBundle {
  return {
    vaultId: row.vault_id,
    zone: row.zone,
    rotationVersion: row.rotation_version,
    wrappedKeys: row.wrapped_keys ?? {},
  };
}

// ---------- Core operations ----------

/**
 * Idempotent vault creation. Two staff opening the Files tab for the same
 * client at the same time both call this; the upsert + re-select pattern
 * keeps it race-safe.
 */
export async function ensureVaultForExternalIdentity(
  externalIdentityId: string,
  actorUserId: string | null,
  trx?: Knex.Transaction,
): Promise<ClientVaultRow> {
  const existed = await clientVaultsRepo.byExternalIdentityId(externalIdentityId, trx);
  const row = await clientVaultsRepo.upsertByExternalIdentityId(externalIdentityId, trx);
  if (!existed) {
    await auditRepo.write({
      actorUserId,
      action: VAULT_AUDIT_ACTIONS.vaultCreated,
      targetType: 'vault',
      targetId: row.id,
      details: { externalIdentityId },
    });
  }
  return row;
}

/**
 * Staff member can see the vault iff they share at least one non-removed
 * conversation membership with the client. When firm_settings.vault_information_barrier
 * is true, the check tightens to "explicit grant" — out of scope for v1, so
 * we simply throw when the flag is on.
 */
export async function assertStaffCanAccessVault(
  userId: string,
  externalIdentityId: string,
  trx?: Knex.Transaction,
): Promise<void> {
  const q = trx ?? db;
  const settings = await q('firm_settings').where({ id: 1 }).first('vault_information_barrier');
  if (settings?.vault_information_barrier) {
    // v1 leaves the explicit-grant table unbuilt; toggling the flag locks
    // every staff out until v2 ships the grant UI.
    throw new VaultServiceError('forbidden', 'information_barrier_enabled');
  }
  const row = await q('conversation_members as cm')
    .join('conversations as c', 'c.id', 'cm.conversation_id')
    .join('conversation_members as cm2', 'cm2.conversation_id', 'c.id')
    .where('cm.user_id', userId)
    .whereNull('cm.removed_at')
    .where('cm2.external_identity_id', externalIdentityId)
    .whereNull('cm2.removed_at')
    .first('cm.id');
  if (!row) throw new VaultServiceError('forbidden');
}

/**
 * Look up the recipient IDs the caller is entitled to see in wrapped_keys.
 * For a staff caller, returns every active device of theirs (each pair
 * `${userId}:${deviceId}`). For a portal caller, returns just the active
 * session id wrapper. The vault never wraps to a per-user "any device"
 * recipient — it's always per-device, mirroring conversation_keys.
 */
export async function recipientIdsForCaller(args: {
  userId?: string;
  externalIdentityId?: string;
  sessionId?: string;
  trx?: Knex.Transaction;
}): Promise<string[]> {
  const q = args.trx ?? db;
  if (args.userId) {
    const devices = await q('user_keys')
      .where({ user_id: args.userId })
      .whereNull('revoked_at')
      .select('device_id');
    return devices.map((d: { device_id: string }) => recipientIdForUserDevice(args.userId!, d.device_id));
  }
  if (args.externalIdentityId && args.sessionId) {
    return [recipientIdForClientSession(args.externalIdentityId, args.sessionId)];
  }
  return [];
}

/**
 * Filter wrapped_keys map down to the entries the caller is entitled to.
 * Returns the same shape minus other recipients' wrapped values. For a
 * portal caller hitting a `staff_only` zone, the upstream call site
 * shouldn't even call this — the repository already returns []. This is
 * the second-line defense.
 */
export function filterWrappedKeysForCaller(
  wrappedKeys: Record<string, string>,
  callerRecipientIds: string[],
): Record<string, string> {
  const allowed = new Set(callerRecipientIds);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(wrappedKeys)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

// ---------- Zone key rotation flows ----------

/**
 * Full rotation: client computes a fresh zone key, wraps to the new
 * membership set, and POSTs the rotated wrapped_keys. Server stores the
 * new (zone, rotation_version) row and audits.
 *
 * Used on staff add/remove (server side only stores + signals; client
 * already wrapped to the new membership before calling).
 */
export async function rotateZoneKey(
  args: {
    actorUserId: string;
    vaultId: string;
    zone: VaultZone;
    rotationVersion: number;
    wrappedKeys: Record<string, string>;
  },
  trx?: Knex.Transaction,
): Promise<VaultKeyRow> {
  const exec = async (t: Knex.Transaction) => {
    const latest = await vaultKeysRepo.latest(args.vaultId, args.zone, t);
    if (latest && latest.rotation_version >= args.rotationVersion) {
      throw new VaultServiceError(
        'invalid_state',
        `rotation_version ${args.rotationVersion} is not newer than ${latest.rotation_version}`,
      );
    }
    const row = await vaultKeysRepo.insert(
      args.vaultId,
      args.zone,
      args.rotationVersion,
      args.wrappedKeys,
      t,
    );
    await auditRepo.write({
      actorUserId: args.actorUserId,
      action: VAULT_AUDIT_ACTIONS.zoneRekeyed,
      targetType: 'vault_zone',
      targetId: args.vaultId,
      details: {
        zone: args.zone,
        rotationVersion: args.rotationVersion,
        recipientCount: Object.keys(args.wrappedKeys).length,
      },
    });
    return row;
  };
  const row = await (trx ? exec(trx) : db.transaction(exec));
  await publish({
    type: 'vault:rekey',
    vaultId: args.vaultId,
    zone: args.zone,
    rotationVersion: args.rotationVersion,
  });
  return row;
}

/**
 * Incremental wrap: a single new device or session joins; we don't rotate
 * the symmetric key, just add a wrapped entry on the latest rotation_version.
 *
 * Refuses to add a `client:*` recipient to staff_only at the repository
 * level (vaultKeysRepo.mergeWrappedAdditive throws). Caller should only
 * use this path on shared zone for client recipients.
 */
export async function addZoneRecipients(
  args: {
    actorUserId: string;
    vaultId: string;
    zone: VaultZone;
    added: Record<string, string>;
  },
  trx?: Knex.Transaction,
): Promise<{ added: string[] }> {
  const exec = async (t: Knex.Transaction) => {
    const latest = await vaultKeysRepo.latest(args.vaultId, args.zone, t);
    if (!latest) {
      throw new VaultServiceError(
        'invalid_state',
        'no zone key exists yet — call rotateZoneKey first',
      );
    }
    const result = await vaultKeysRepo.mergeWrappedAdditive(latest.id, args.added, t);
    if (result.added.length > 0) {
      await auditRepo.write({
        actorUserId: args.actorUserId,
        action: VAULT_AUDIT_ACTIONS.zoneRecipientAdded,
        targetType: 'vault_zone',
        targetId: args.vaultId,
        details: { zone: args.zone, added: result.added },
      });
    }
    return result;
  };
  return trx ? exec(trx) : db.transaction(exec);
}

// ---------- Folder / file CRUD (the parts not handled by tus) ----------

export async function createFolder(args: {
  actorUserId: string;
  vaultId: string;
  zone: VaultZone;
  parentFolderId: string | null;
  nameCiphertext: string;
  contentKeyVersion: number;
  sortOrder?: number;
}): Promise<VaultFolderRow> {
  return db.transaction(async (trx) => {
    // Reject parentFolderId on v1 — one-level nesting only.
    if (args.parentFolderId) {
      const parent = await vaultFoldersRepo.byId(args.parentFolderId, trx);
      if (!parent) throw new VaultServiceError('not_found', 'parent_folder');
      if (parent.parent_folder_id !== null) {
        throw new VaultServiceError('invalid_state', 'nesting_depth_exceeded');
      }
      if (parent.zone !== args.zone) {
        throw new VaultServiceError('zone_violation', 'parent_zone_mismatch');
      }
    }
    const row = await vaultFoldersRepo.insert(
      {
        vault_id: args.vaultId,
        parent_folder_id: args.parentFolderId,
        zone: args.zone,
        name_ciphertext: args.nameCiphertext,
        content_key_version: args.contentKeyVersion,
        sort_order: args.sortOrder ?? 0,
      },
      trx,
    );
    await auditRepo.write({
      actorUserId: args.actorUserId,
      action: VAULT_AUDIT_ACTIONS.folderCreated,
      targetType: 'vault_folder',
      targetId: row.id,
      details: { vaultId: args.vaultId, zone: args.zone },
    });
    return row;
  });
}

export async function patchFolder(args: {
  actorUserId: string;
  /**
   * IDOR guard: caller must pass the vaultId they intend to operate on.
   * Service refuses if the folder belongs to a different vault. Without
   * this, any staff with access to *any* vault could mutate folders in
   * any other vault by passing a UUID.
   */
  vaultId: string;
  folderId: string;
  patch: {
    nameCiphertext?: string;
    contentKeyVersion?: number;
    sortOrder?: number;
    parentFolderId?: string | null;
  };
}): Promise<VaultFolderRow> {
  return db.transaction(async (trx) => {
    const before = await vaultFoldersRepo.byId(args.folderId, trx);
    if (!before) throw new VaultServiceError('not_found');
    if (before.vault_id !== args.vaultId) throw new VaultServiceError('not_found');
    if (before.deleted_at) throw new VaultServiceError('invalid_state', 'deleted');
    const updates: Parameters<typeof vaultFoldersRepo.updatePartial>[1] = {};
    if (args.patch.nameCiphertext !== undefined) updates.name_ciphertext = args.patch.nameCiphertext;
    if (args.patch.contentKeyVersion !== undefined)
      updates.content_key_version = args.patch.contentKeyVersion;
    if (args.patch.sortOrder !== undefined) updates.sort_order = args.patch.sortOrder;
    if (args.patch.parentFolderId !== undefined) updates.parent_folder_id = args.patch.parentFolderId;
    const after = await vaultFoldersRepo.updatePartial(args.folderId, updates, trx);
    if (!after) throw new VaultServiceError('not_found');
    const isRename = args.patch.nameCiphertext !== undefined && Object.keys(updates).length === 1;
    const isMove = args.patch.parentFolderId !== undefined;
    const action = isRename
      ? VAULT_AUDIT_ACTIONS.folderRenamed
      : isMove
        ? VAULT_AUDIT_ACTIONS.folderMoved
        : VAULT_AUDIT_ACTIONS.folderRenamed;
    await auditRepo.write({
      actorUserId: args.actorUserId,
      action,
      targetType: 'vault_folder',
      targetId: args.folderId,
      details: { fields: Object.keys(updates) },
    });
    return after;
  });
}

export async function deleteFolder(args: {
  actorUserId: string;
  /** IDOR guard: caller asserts which vault the folder belongs to. */
  vaultId: string;
  folderId: string;
}): Promise<void> {
  return db.transaction(async (trx) => {
    const before = await vaultFoldersRepo.byId(args.folderId, trx);
    if (!before) throw new VaultServiceError('not_found');
    if (before.vault_id !== args.vaultId) throw new VaultServiceError('not_found');
    const row = await vaultFoldersRepo.softDelete(args.folderId, trx);
    if (!row) throw new VaultServiceError('not_found');
    await auditRepo.write({
      actorUserId: args.actorUserId,
      action: VAULT_AUDIT_ACTIONS.folderDeleted,
      targetType: 'vault_folder',
      targetId: args.folderId,
      details: { vaultId: row.vault_id, zone: row.zone },
    });
  });
}

export async function patchFile(args: {
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
  /** IDOR guard: caller asserts which vault the file belongs to. */
  vaultId: string;
  fileId: string;
  patch: {
    filenameCiphertext?: string;
    contentKeyVersion?: number;
    folderId?: string | null;
    retentionExpiresAt?: string | null;
  };
}): Promise<VaultFileRow> {
  return db.transaction(async (trx) => {
    const before = await vaultFilesRepo.byId(args.fileId, trx);
    if (!before || before.deleted_at) throw new VaultServiceError('not_found');
    if (before.vault_id !== args.vaultId) throw new VaultServiceError('not_found');
    // Folder move must stay within the file's zone.
    if (args.patch.folderId) {
      const folder = await vaultFoldersRepo.byId(args.patch.folderId, trx);
      if (!folder || folder.deleted_at) throw new VaultServiceError('not_found', 'target_folder');
      if (folder.zone !== before.zone) throw new VaultServiceError('zone_violation');
      if (folder.vault_id !== before.vault_id) throw new VaultServiceError('zone_violation');
    }
    const after = await vaultFilesRepo.updatePartial(
      args.fileId,
      {
        filename_ciphertext: args.patch.filenameCiphertext,
        content_key_version: args.patch.contentKeyVersion,
        folder_id: args.patch.folderId === undefined ? undefined : args.patch.folderId,
        retention_expires_at: args.patch.retentionExpiresAt ?? undefined,
      },
      trx,
    );
    if (!after) throw new VaultServiceError('not_found');
    const action =
      args.patch.folderId !== undefined
        ? VAULT_AUDIT_ACTIONS.fileMoved
        : VAULT_AUDIT_ACTIONS.fileRenamed;
    await auditRepo.write({
      actorUserId: args.actorUserId,
      actorExternalIdentityId: args.actorExternalIdentityId,
      action,
      targetType: 'vault_file',
      targetId: args.fileId,
      details: { vaultId: before.vault_id, zone: before.zone },
    });
    return after;
  });
}

export async function deleteFile(args: {
  actorUserId: string | null;
  actorExternalIdentityId: string | null;
  /** IDOR guard: caller asserts which vault the file belongs to. */
  vaultId: string;
  fileId: string;
  /** Only honoured when actor is a portal client; staff bypass this gate. */
  clientCanDelete?: boolean;
}): Promise<void> {
  const { externalIdentityId, vaultId, zone } = await db.transaction(async (trx) => {
    const before = await vaultFilesRepo.byId(args.fileId, trx);
    if (!before || before.deleted_at) throw new VaultServiceError('not_found');
    if (before.vault_id !== args.vaultId) throw new VaultServiceError('not_found');
    if (args.actorExternalIdentityId) {
      // Portal caller: must own the upload and firm must allow client deletion.
      if (
        !args.clientCanDelete ||
        before.uploaded_by_external_identity_id !== args.actorExternalIdentityId
      ) {
        await auditRepo.write({
          actorExternalIdentityId: args.actorExternalIdentityId,
          action: VAULT_AUDIT_ACTIONS.clientDeleteBlocked,
          targetType: 'vault_file',
          targetId: args.fileId,
          details: {
            reason: !args.clientCanDelete ? 'firm_disallowed' : 'not_uploader',
          },
        });
        throw new VaultServiceError('client_delete_blocked');
      }
    }
    await vaultFilesRepo.softDelete(args.fileId, trx);
    await auditRepo.write({
      actorUserId: args.actorUserId,
      actorExternalIdentityId: args.actorExternalIdentityId,
      action: VAULT_AUDIT_ACTIONS.fileDeleted,
      targetType: 'vault_file',
      targetId: args.fileId,
      details: { vaultId: before.vault_id, zone: before.zone },
    });
    const vault = await clientVaultsRepo.byId(before.vault_id, trx);
    return {
      externalIdentityId: vault?.external_identity_id ?? '',
      vaultId: before.vault_id,
      zone: before.zone,
    };
  });
  await publish({
    type: 'vault:file-deleted',
    vaultId,
    externalIdentityId,
    fileId: args.fileId,
    zone,
    actorUserId: args.actorUserId,
    actorExternalIdentityId: args.actorExternalIdentityId,
  });
}

// ---------- Vault listing for staff and portal ----------

/**
 * Build a full vault response for a single zone. Returns the ciphertext rows
 * the caller is allowed to see plus the wrapped key bundles they can decrypt.
 *
 * For staff: both zones if they share a conversation with the client.
 * For portal: shared zone only, gated by step-up.
 */
export async function listVaultZone(args: {
  vaultId: string;
  zone: VaultZone;
  callerRecipientIds: string[];
  trx?: Knex.Transaction;
}): Promise<{ folders: VaultFolderRow[]; files: VaultFileRow[]; keys: VaultKeyRow[] }> {
  const trx = args.trx;
  // The repository layer already enforces zone separation per-recipient,
  // but we double-check here for callers that pass an empty recipient list.
  const keys: VaultKeyRow[] = [];
  for (const rid of args.callerRecipientIds) {
    const rows = await vaultKeysRepo.byVaultIdForSession(args.vaultId, rid, args.zone, trx);
    keys.push(...rows);
  }
  // De-dupe by id since multiple staff devices can each request the same
  // key rows.
  const keyMap = new Map<string, VaultKeyRow>();
  for (const k of keys) keyMap.set(k.id, k);
  const folders = await vaultFoldersRepo.listByVaultZone(args.vaultId, args.zone, trx);
  const files = await vaultFilesRepo.listByVaultZone(args.vaultId, args.zone, trx);
  return { folders, files, keys: Array.from(keyMap.values()) };
}

/**
 * Step-up gate parallel to routes/portalConversations.ts:133-149. Withholds
 * wrapped keys when the portal session is missing valid SSN/EIN verification.
 * Audits the withhold so admins can spot probing.
 */
export async function withholdKeysForUnverifiedSession(args: {
  externalIdentityId: string;
  sessionVerifiedUntil: string | null;
  verificationRequired: boolean;
  hasLast4Hash: boolean;
  vaultId: string;
}): Promise<boolean> {
  const stepupNeeded =
    args.verificationRequired &&
    args.hasLast4Hash &&
    (!args.sessionVerifiedUntil || new Date(args.sessionVerifiedUntil) < new Date());
  if (!stepupNeeded) return false;
  await auditRepo.write({
    actorExternalIdentityId: args.externalIdentityId,
    action: VAULT_AUDIT_ACTIONS.portalKeyWithheldStepup,
    targetType: 'vault',
    targetId: args.vaultId,
    details: { reason: 'verification_required' },
  });
  return true;
}
