// Phase 26 — Client Vault repositories.
//
// Five thin wrappers over the Phase 26 schema. Business logic, audit, and
// realtime publishes live in services/vaultService.ts; this module is
// purely query plumbing so the service stays test-friendly.
//
// Hard zone-separation invariant: `vaultKeysRepo.byVaultIdForSession`
// refuses to return staff_only rows for any `client:*` recipient id,
// regardless of caller. This is the load-bearing check; route-layer
// guards exist in addition, not instead.
import type { Knex } from 'knex';
import type { VaultZone } from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';

export interface ClientVaultRow {
  id: string;
  external_identity_id: string;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface VaultKeyRow {
  id: string;
  vault_id: string;
  zone: VaultZone;
  rotation_version: number;
  wrapped_keys: Record<string, string>;
  created_at: string;
}

export interface VaultFolderRow {
  id: string;
  vault_id: string;
  parent_folder_id: string | null;
  zone: VaultZone;
  name_ciphertext: string;
  content_key_version: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VaultFileRow {
  id: string;
  vault_id: string;
  folder_id: string | null;
  zone: VaultZone;
  filename_ciphertext: string;
  mime_type: string;
  size_bytes: string | number; // bigint deserialises as string under node-postgres
  storage_path: string;
  wrapped_file_key: Buffer;
  content_key_version: number;
  envelope_format: string;
  scan_status: 'pending' | 'clean' | 'infected';
  version: number;
  prior_version_id: string | null;
  uploaded_by_user_id: string | null;
  uploaded_by_external_identity_id: string | null;
  uploaded_at: string;
  retention_expires_at: string | null;
  deleted_at: string | null;
}

export interface VaultUploadRow {
  id: string;
  upload_url_id: string;
  vault_id: string;
  zone: VaultZone;
  folder_id: string | null;
  expected_size: string | number;
  bytes_received: string | number;
  metadata: Record<string, unknown>;
  expires_at: string;
  created_by_user_id: string | null;
  created_by_external_identity_id: string | null;
  created_at: string;
}

// Recipient ID format from routes/conversations.ts:631-636. A "client:" prefix
// identifies anyone whose unwrap path runs in the portal — sessions, invites.
function isClientRecipient(recipientId: string): boolean {
  return recipientId.startsWith('client:');
}

export const clientVaultsRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ClientVaultRow>('client_vaults').where({ id }).first();
  },
  byExternalIdentityId(externalIdentityId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<ClientVaultRow>('client_vaults')
      .where({ external_identity_id: externalIdentityId })
      .first();
  },
  /**
   * Idempotent create. Used by ensureVaultForExternalIdentity. ON CONFLICT
   * DO NOTHING + re-select avoids the race where two staff members open the
   * Files tab simultaneously and both try to create.
   */
  async upsertByExternalIdentityId(
    externalIdentityId: string,
    trx?: Knex.Transaction,
  ): Promise<ClientVaultRow> {
    const q = trx ?? db;
    await q('client_vaults')
      .insert({ external_identity_id: externalIdentityId })
      .onConflict('external_identity_id')
      .ignore();
    const row = await q<ClientVaultRow>('client_vaults')
      .where({ external_identity_id: externalIdentityId })
      .first();
    return row!;
  },
  async updateSettings(
    id: string,
    settings: Record<string, unknown>,
    trx?: Knex.Transaction,
  ): Promise<ClientVaultRow | undefined> {
    const [row] = await (trx ?? db)<ClientVaultRow>('client_vaults')
      .where({ id })
      .update({ settings: JSON.stringify(settings) as unknown as never })
      .returning('*');
    return row;
  },
};

export const vaultKeysRepo = {
  async latest(
    vaultId: string,
    zone: VaultZone,
    trx?: Knex.Transaction,
  ): Promise<VaultKeyRow | undefined> {
    return (trx ?? db)<VaultKeyRow>('vault_keys')
      .where({ vault_id: vaultId, zone })
      .orderBy('rotation_version', 'desc')
      .first();
  },
  async allVersions(vaultId: string, zone: VaultZone, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultKeyRow>('vault_keys')
      .where({ vault_id: vaultId, zone })
      .orderBy('rotation_version', 'asc');
  },
  /**
   * Hard zone-separation invariant: a `client:*` recipient never sees
   * staff_only rows. Returning [] (not throwing) keeps the API quiet —
   * adversarial probing can't tell the difference between "no such zone"
   * and "you're not allowed to see this zone".
   */
  async byVaultIdForSession(
    vaultId: string,
    recipientId: string,
    zone: VaultZone,
    trx?: Knex.Transaction,
  ): Promise<VaultKeyRow[]> {
    if (zone === 'staff_only' && isClientRecipient(recipientId)) return [];
    return (trx ?? db)<VaultKeyRow>('vault_keys')
      .where({ vault_id: vaultId, zone })
      .orderBy('rotation_version', 'asc');
  },
  async insert(
    vaultId: string,
    zone: VaultZone,
    rotationVersion: number,
    wrappedKeys: Record<string, string>,
    trx?: Knex.Transaction,
  ): Promise<VaultKeyRow> {
    // CRYPTO: server-side guard. staff_only rotations must not carry any
    // `client:*` recipient — even if the caller mis-uploads. Silent rejection
    // would mask a client bug; throw so the caller's error path runs.
    if (zone === 'staff_only') {
      for (const r of Object.keys(wrappedKeys)) {
        if (isClientRecipient(r)) {
          throw new Error(`vault_keys insert: client recipient ${r} forbidden in staff_only zone`);
        }
      }
    }
    const [row] = await (trx ?? db)<VaultKeyRow>('vault_keys')
      .insert({
        vault_id: vaultId,
        zone,
        rotation_version: rotationVersion,
        wrapped_keys: JSON.stringify(wrappedKeys) as unknown as never,
      })
      .returning('*');
    return row!;
  },
  /**
   * Additive merge for incremental wraps (member added without rotation).
   * Mirrors conversationKeysRepo.mergeWrappedAdditive — additive-only,
   * race-safe, returns which keys actually landed.
   */
  async mergeWrappedAdditive(
    id: string,
    added: Record<string, string>,
    trx?: Knex.Transaction,
  ): Promise<{ added: string[] }> {
    const q = trx ?? db;
    const row = await q<VaultKeyRow>('vault_keys').where({ id }).first();
    if (!row) return { added: [] };
    if (row.zone === 'staff_only') {
      for (const r of Object.keys(added)) {
        if (isClientRecipient(r)) {
          throw new Error(`vault_keys merge: client recipient ${r} forbidden in staff_only zone`);
        }
      }
    }
    const existing = row.wrapped_keys ?? {};
    const toAdd: Record<string, string> = {};
    for (const [k, v] of Object.entries(added)) {
      if (!(k in existing)) toAdd[k] = v;
    }
    if (Object.keys(toAdd).length === 0) return { added: [] };
    await q('vault_keys')
      .where({ id })
      .update({
        wrapped_keys: db.raw(
          `COALESCE(wrapped_keys, '{}'::jsonb) || ?::jsonb || COALESCE(wrapped_keys, '{}'::jsonb)`,
          [JSON.stringify(toAdd)],
        ),
      });
    return { added: Object.keys(toAdd) };
  },
  /**
   * Crypto-shred: zero out wrapped_keys so no recipient can decrypt the zone
   * bytes-on-disk anymore. Bytes stay until the next backup prune.
   */
  async cryptoShred(vaultId: string, zone: VaultZone, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('vault_keys')
      .where({ vault_id: vaultId, zone })
      .update({ wrapped_keys: JSON.stringify({}) as unknown as never });
  },
};

export const vaultFoldersRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFolderRow>('vault_folders').where({ id }).first();
  },
  /** Live (non-deleted) folders for a zone. Sorted by sort_order then created_at. */
  async listByVaultZone(vaultId: string, zone: VaultZone, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFolderRow>('vault_folders')
      .where({ vault_id: vaultId, zone })
      .whereNull('deleted_at')
      .orderBy([{ column: 'sort_order' }, { column: 'created_at' }]);
  },
  async insert(
    row: Pick<
      VaultFolderRow,
      | 'vault_id'
      | 'parent_folder_id'
      | 'zone'
      | 'name_ciphertext'
      | 'content_key_version'
      | 'sort_order'
    >,
    trx?: Knex.Transaction,
  ): Promise<VaultFolderRow> {
    const [created] = await (trx ?? db)<VaultFolderRow>('vault_folders')
      .insert({
        vault_id: row.vault_id,
        parent_folder_id: row.parent_folder_id ?? null,
        zone: row.zone,
        name_ciphertext: row.name_ciphertext,
        content_key_version: row.content_key_version,
        sort_order: row.sort_order,
      })
      .returning('*');
    return created!;
  },
  async updatePartial(
    id: string,
    patch: Partial<
      Pick<
        VaultFolderRow,
        'name_ciphertext' | 'content_key_version' | 'sort_order' | 'parent_folder_id'
      >
    >,
    trx?: Knex.Transaction,
  ): Promise<VaultFolderRow | undefined> {
    const [row] = await (trx ?? db)<VaultFolderRow>('vault_folders')
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
  async softDelete(id: string, trx?: Knex.Transaction): Promise<VaultFolderRow | undefined> {
    const [row] = await (trx ?? db)<VaultFolderRow>('vault_folders')
      .where({ id })
      .whereNull('deleted_at')
      .update({ deleted_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
  async restore(id: string, trx?: Knex.Transaction): Promise<VaultFolderRow | undefined> {
    const [row] = await (trx ?? db)<VaultFolderRow>('vault_folders')
      .where({ id })
      .update({ deleted_at: null, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
};

export const vaultFilesRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFileRow>('vault_files').where({ id }).first();
  },
  async listByVaultZone(vaultId: string, zone: VaultZone, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFileRow>('vault_files')
      .where({ vault_id: vaultId, zone })
      .whereNull('deleted_at')
      .orderBy('uploaded_at', 'desc');
  },
  async listByFolder(folderId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFileRow>('vault_files')
      .where({ folder_id: folderId })
      .whereNull('deleted_at')
      .orderBy('uploaded_at', 'desc');
  },
  async insert(
    row: Pick<
      VaultFileRow,
      | 'vault_id'
      | 'folder_id'
      | 'zone'
      | 'filename_ciphertext'
      | 'mime_type'
      | 'size_bytes'
      | 'storage_path'
      | 'wrapped_file_key'
      | 'content_key_version'
      | 'envelope_format'
      | 'scan_status'
      | 'uploaded_by_user_id'
      | 'uploaded_by_external_identity_id'
    > & { retention_expires_at?: string | null },
    trx?: Knex.Transaction,
  ): Promise<VaultFileRow> {
    const [created] = await (trx ?? db)<VaultFileRow>('vault_files')
      .insert({
        vault_id: row.vault_id,
        folder_id: row.folder_id ?? null,
        zone: row.zone,
        filename_ciphertext: row.filename_ciphertext,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_path: row.storage_path,
        wrapped_file_key: row.wrapped_file_key,
        content_key_version: row.content_key_version,
        envelope_format: row.envelope_format,
        scan_status: row.scan_status,
        uploaded_by_user_id: row.uploaded_by_user_id,
        uploaded_by_external_identity_id: row.uploaded_by_external_identity_id,
        retention_expires_at: row.retention_expires_at ?? null,
      })
      .returning('*');
    return created!;
  },
  async updateScanStatus(
    id: string,
    status: 'clean' | 'infected',
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx ?? db)('vault_files').where({ id }).update({ scan_status: status });
  },
  async updatePartial(
    id: string,
    patch: Partial<
      Pick<
        VaultFileRow,
        'filename_ciphertext' | 'folder_id' | 'content_key_version' | 'retention_expires_at'
      >
    >,
    trx?: Knex.Transaction,
  ): Promise<VaultFileRow | undefined> {
    const [row] = await (trx ?? db)<VaultFileRow>('vault_files')
      .where({ id })
      .update(patch)
      .returning('*');
    return row;
  },
  async softDelete(id: string, trx?: Knex.Transaction): Promise<VaultFileRow | undefined> {
    const [row] = await (trx ?? db)<VaultFileRow>('vault_files')
      .where({ id })
      .whereNull('deleted_at')
      .update({ deleted_at: db.fn.now() })
      .returning('*');
    return row;
  },
  async restore(id: string, trx?: Knex.Transaction): Promise<VaultFileRow | undefined> {
    const [row] = await (trx ?? db)<VaultFileRow>('vault_files')
      .where({ id })
      .update({ deleted_at: null })
      .returning('*');
    return row;
  },
  async hardDeleteRow(id: string, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)<VaultFileRow>('vault_files').where({ id }).del();
  },
  /**
   * Files whose retention has expired (live rows only). Used by the cron
   * sweep in services/vaultRetention.ts.
   */
  async listExpired(trx?: Knex.Transaction) {
    return (trx ?? db)<VaultFileRow>('vault_files')
      .whereNotNull('retention_expires_at')
      .where('retention_expires_at', '<', db.fn.now())
      .whereNull('deleted_at');
  },
};

export const vaultUploadsRepo = {
  byUploadUrlId(uploadUrlId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<VaultUploadRow>('vault_uploads_in_progress')
      .where({ upload_url_id: uploadUrlId })
      .first();
  },
  async insert(
    row: Pick<
      VaultUploadRow,
      | 'upload_url_id'
      | 'vault_id'
      | 'zone'
      | 'folder_id'
      | 'expected_size'
      | 'metadata'
      | 'expires_at'
      | 'created_by_user_id'
      | 'created_by_external_identity_id'
    >,
    trx?: Knex.Transaction,
  ): Promise<VaultUploadRow> {
    const [created] = await (trx ?? db)<VaultUploadRow>('vault_uploads_in_progress')
      .insert({
        upload_url_id: row.upload_url_id,
        vault_id: row.vault_id,
        zone: row.zone,
        folder_id: row.folder_id ?? null,
        expected_size: row.expected_size,
        metadata: JSON.stringify(row.metadata ?? {}) as unknown as never,
        expires_at: row.expires_at,
        created_by_user_id: row.created_by_user_id,
        created_by_external_identity_id: row.created_by_external_identity_id,
      })
      .returning('*');
    return created!;
  },
  async setBytesReceived(
    uploadUrlId: string,
    bytesReceived: number,
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx ?? db)('vault_uploads_in_progress')
      .where({ upload_url_id: uploadUrlId })
      .update({ bytes_received: bytesReceived });
  },
  async deleteByUploadUrlId(uploadUrlId: string, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('vault_uploads_in_progress').where({ upload_url_id: uploadUrlId }).del();
  },
  async reapExpired(trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)('vault_uploads_in_progress').where('expires_at', '<', db.fn.now()).del();
  },
};
