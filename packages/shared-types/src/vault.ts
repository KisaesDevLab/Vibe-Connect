// Phase 26 — Client Vault types. Shared across server, web, portal, desktop.
// Types only — no runtime code.

export type VaultZone = 'shared' | 'staff_only';

export type VaultScanStatus = 'pending' | 'clean' | 'infected';

export interface ClientVault {
  id: string;
  externalIdentityId: string;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface VaultKeyBundle {
  vaultId: string;
  zone: VaultZone;
  rotationVersion: number;
  // {recipientId: wrappedKeyBase64}; absent for staff_only when caller is a client session.
  wrappedKeys: Record<string, string> | null;
}

export interface VaultFolder {
  id: string;
  vaultId: string;
  parentFolderId: string | null;
  zone: VaultZone;
  // base64-encoded SymmetricEnvelope under the zone key
  nameCiphertext: string;
  contentKeyVersion: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VaultFile {
  id: string;
  vaultId: string;
  folderId: string | null;
  zone: VaultZone;
  filenameCiphertext: string;
  mimeType: string;
  sizeBytes: number;
  // wrapped per-file key (base64). The server-side bytea round-trips through base64 at the API boundary.
  wrappedFileKey: string;
  contentKeyVersion: number;
  envelopeFormat: string; // 'vault-zone-key-v1'
  scanStatus: VaultScanStatus;
  version: number;
  priorVersionId: string | null;
  uploadedByUserId: string | null;
  uploadedByExternalIdentityId: string | null;
  uploadedAt: string;
  retentionExpiresAt: string | null;
  deletedAt: string | null;
}

export interface VaultFolderTemplate {
  nameTemplate: string;
  zone: VaultZone;
  retentionDays: number | null;
}

export interface VaultListResponse {
  vault: ClientVault;
  folders: VaultFolder[];
  files: VaultFile[];
  keys: VaultKeyBundle[]; // one bundle per (zone, rotationVersion) the caller is authorized for
  // True iff a portal session is missing valid SSN/EIN step-up. When set, `keys` is filtered to
  // empty for any zone the caller cannot decrypt; staff_only is always absent for portal.
  stepupRequired?: boolean;
  vaultDisabled?: boolean;
}

// Reserved keys on `messages.ciphertext_meta` for vault system events.
export interface VaultSystemMessageMeta {
  vaultFileId?: string;
  vaultFolderId?: string;
  vaultZone?: 'shared'; // staff_only events never appear in client-visible threads
  systemEventType?: 'vault_file_uploaded' | 'vault_file_deleted';
}

// Realtime fanout payloads (pgFanout)
export interface VaultRealtimeUploadEvent {
  type: 'vault:file-uploaded';
  vaultId: string;
  externalIdentityId: string;
  fileId: string;
  zone: VaultZone;
  actorUserId?: string | null;
  actorExternalIdentityId?: string | null;
}

export interface VaultRealtimeDeleteEvent {
  type: 'vault:file-deleted';
  vaultId: string;
  externalIdentityId: string;
  fileId: string;
  zone: VaultZone;
  actorUserId?: string | null;
  actorExternalIdentityId?: string | null;
}

export interface VaultRealtimeRekeyEvent {
  type: 'vault:rekey';
  vaultId: string;
  zone: VaultZone;
  rotationVersion: number;
}

export type VaultRealtimeEvent =
  | VaultRealtimeUploadEvent
  | VaultRealtimeDeleteEvent
  | VaultRealtimeRekeyEvent;
