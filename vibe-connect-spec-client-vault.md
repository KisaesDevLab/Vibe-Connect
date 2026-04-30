# Vibe Connect — Client Vault (proposal)

*Per-client persistent file storage with the same E2EE guarantees as messaging.*

---

## Goal

Give each client a durable, E2EE file storage area that lives independently of message conversations. Solves the "scroll through chat for the W-2 you sent in March" problem and gives the firm a known location for engagement records, source documents, signed forms, and workpapers — using the same crypto primitives, tus upload pipeline, and ClamAV scan flow already built for message attachments.

## Concept

One **Client Vault** per `external_identity`. Two zones inside each vault:

- **Shared** — visible to staff and the client. Engagement letters, returns, organizers, signed 8879s, source docs.
- **Staff-only** — visible to staff only. Workpapers, internal notes, prior-preparer comments, anything the client should never see. Mirrors the `internal_thread` pattern from conversations: the client session can never decrypt staff-only objects because the staff-only zone key is never wrapped to it.

Conversations and the vault are siblings under the client, not parent/child. A vault outlives any single engagement or year.

## Trust model

- Each vault has two zone keys (XChaCha20-Poly1305): `shared_key` and `staff_only_key`.
- `shared_key` → wrapped to all staff device keys + the client's active session keys.
- `staff_only_key` → wrapped to staff device keys only. Server enforces at the API layer that this wrapped value is never delivered to a client session.
- Per-file key generated client-side, wrapped to the relevant zone key. Server stores ciphertext only.
- Zone keys rotate on staff add/remove, identical to conversation keys.
- Firm recovery phrase still authorises emergency decryption of either zone.
- Files inherit the existing on-disk encryption, tus chunked upload, and ClamAV sandbox flow from Phase 21.

## Data model (new tables)

```
client_vaults
  id, external_identity_id, settings JSONB, created_at

vault_keys
  id, vault_id, zone ('shared' | 'staff_only'),
  wrapped_keys JSONB,   -- maps user_key_id | client_session_id -> wrapped key
  rotation_version

vault_folders
  id, vault_id, parent_folder_id (nullable, self-ref),
  zone ('shared' | 'staff_only'),
  name_ciphertext, sort_order, created_at, deleted_at

vault_files
  id, vault_id, folder_id (nullable), zone,
  filename_ciphertext, mime_type, size_bytes,
  storage_path, wrapped_file_key (bytea),
  version int, prior_version_id (nullable, self-ref),
  uploaded_by_user_id (nullable),
  uploaded_by_external_identity_id (nullable),
  uploaded_at, deleted_at

vault_audit_log
  id, vault_id,
  actor_user_id (nullable), actor_external_identity_id (nullable),
  action ('upload' | 'download' | 'delete' | 'rename' | 'move' | 'restore'),
  file_id (nullable), folder_id (nullable),
  details JSONB, created_at
```

Filenames are encrypted (`filename_ciphertext`) the same way message attachments are. `mime_type` and `size_bytes` remain plaintext — same compromise as `attachments`.

## Permissions

- Staff with access to the client's conversation get vault access automatically. Configurable to require explicit grant for firms with stricter information barriers.
- Client session can read/write to the Shared zone only after SSN/EIN step-up succeeds. Gated server-side: server refuses to deliver `shared_key` to an unverified session.
- Admin can revoke any session and restrict per-staff access to specific clients (mirrors the existing client-conversation revocation).
- Server enforces zone separation as a hard invariant: `staff_only_key` lookups by an `external_identity` session return 403, always.

## API surface

```
GET    /clients/:id/vault                       -- folder + file tree (ciphertext)
POST   /clients/:id/vault/folders               -- create folder
PATCH  /clients/:id/vault/folders/:fid          -- rename / move
DELETE /clients/:id/vault/folders/:fid          -- soft delete

POST   /clients/:id/vault/files                 -- multipart ciphertext upload + wrapped file key
GET    /clients/:id/vault/files/:fid            -- streams ciphertext
PATCH  /clients/:id/vault/files/:fid            -- rename / move
DELETE /clients/:id/vault/files/:fid            -- soft delete (crypto-shred at retention boundary)
POST   /clients/:id/vault/files/:fid/versions   -- new version of an existing logical file

POST   /clients/:id/vault/rotate-keys           -- staff add/remove triggers rewrap
```

Same tus protocol, same ClamAV pipeline, same `storage_path` conventions as `attachments`. The endpoints exist solely to keep vault objects out of the message-attachment lifecycle.

## UX

### Staff app
- New route `/clients/:id/files`, reachable from the client conversation header and from a global Clients list.
- Two-pane layout: folder tree (left), file list (right). Tab toggle at top: **Shared** / **Staff-only**.
- Drag-and-drop upload, multi-select, rename, move.
- Per-file actions: download, attach-to-message (inserts a vault reference into the conversation, no file copy), set retention, view audit log.
- Upload from inside a conversation can route to either the conversation (existing message attachment) or the vault (new), with a small picker.

### Client portal
- New "Files" nav item alongside Messages.
- Shared zone only. The staff-only zone is invisible — no UI affordance, no count, no hint.
- Upload, download, and delete their own uploads (delete configurable per firm).
- SSN/EIN step-up gates access exactly like message decryption.

## Folder templates

Optional per-firm templates that auto-instantiate when a client is created or a new tax year starts. Suggested defaults:

```
Tax Year YYYY/
  Source Documents/        (shared)
  Workpapers/              (staff-only)
  Final Deliverables/      (shared)
  Signed Forms/            (shared)
Permanent File/            (staff-only)
Bookkeeping/               (shared)
```

Admin-configurable. The "new tax year" trigger is a simple cron + admin acknowledgement, not automatic.

## Workflows this enables

- Staff uploads last year's return to `Permanent File/` once; available forever without re-asking the client.
- Client drops a W-2 into `Source Documents/`; staff gets a notification, file appears in their files view, conversation log records the event with a `system` source message.
- Signed Form 8879 lands in `Signed Forms/` directly from the e-sign integration (when built).
- Year-end: retention policy crypto-shreds zone keys for closed engagements per firm policy. Bytes on disk become unreadable without touching them.
- Peer review: managing partner exports the entire vault for a sampled client via the existing recovery-phrase audit flow. Audit log captures the export.

## Notifications

- Reuse the existing notification stream. Vault uploads emit `vault:file-uploaded` events scoped to the conversation members.
- Push payloads carry only metadata (vault id, file id, actor id) — never filenames or content. Same hygiene as message notifications.
- Client uploads notify all staff with conversation access; staff uploads to the Shared zone notify the client per their existing notification preferences.

## Bridged inbound (defer to v2)

Email-in attachments could route to an `Inbox/` folder in the Shared zone instead of as inline message attachments. Needs rules + a triage UI; defer.

## Phasing

**v1 — lands alongside or immediately after Phase 21 (client UI + secure upload)**

- Per-client vault with Shared + Staff-only zones
- One level of folder nesting maximum
- Upload / download from both sides, E2EE
- ClamAV scan reused as-is
- Basic audit log
- Upload notifications via existing channels

**v2**

- Folder templates per engagement type
- File versioning (`prior_version_id` already in schema)
- Arbitrary folder nesting
- Encrypted client-side filename search (FlexSearch over decrypted vault filenames, mirroring message search in Phase 10)
- E-sign integration / 8879 routing
- Email-in attachment routing
- Multi-client vaults (e.g., joint 1040)

## Open decisions

1. **Vault per client or vault per engagement?** Recommend per-client with engagement *folders*. Matches how CPA firms think and avoids object multiplication. Per-engagement adds clean retention boundaries but at the cost of cross-year context.
2. **Client deletion rights.** Recommend configurable per firm, default "soft-delete with audit log entry." Most firms care about the trail more than the file.
3. **Max file size.** Recommend 250 MB for vault vs the 100 MB message-attachment cap. QuickBooks `.qbb` files alone push past 100 MB regularly. Tax PDFs with K-1 packets do too.
4. **Folder-level ACLs inside a zone.** Recommend zone-only ACLs for v1. Sub-folder ACLs add UI complexity disproportionate to the demand.
5. **Multi-client matter** (joint 1040 — two `external_identities`, one shared vault). Recommend an `external_identity_group` concept tying spouses together. Defer to v2.
6. **Storage backend.** Vault inherits the appliance volume by default. Decision point: does the optional S3 driver already in the messaging stack apply to vault objects too, or do we want a separate `VAULT_STORAGE_*` env var family for firms that want messages local but vaults on encrypted object storage? Recommend single shared driver, single env var family.
7. **Retention policy granularity.** Per-folder, per-zone, or per-vault? Recommend per-folder for v1, with sensible inheritance from zone defaults.

## Threat model deltas

- **Plaintext window.** Same as message attachments: ClamAV sandbox is the one moment a vault file exists as plaintext server-side. Worth calling out explicitly in `docs/THREAT_MODEL.md` rather than relying on the message-attachment language to imply it.
- **Side-channel leakage.** File sizes, mime types, and upload timestamps remain plaintext metadata. A staff member with DB access could infer engagement activity from size patterns even without decryption. Acceptable given the firm-trust model, but document.
- **Client-uploaded malware.** Clients are not a privileged threat actor, but the upload path is a direct attack surface. ClamAV plus the existing file-type allowlist (extended for vault to include `.qbb`, `.qbm`, `.qbo`) is the v1 mitigation.

## Definition of done (v1)

- A staff member can create a folder and upload a file in either zone in under 30 seconds.
- A client can upload a source document via the portal and the file appears in the staff Files view in under 10 seconds with a notification.
- Server fails-closed: a client session attempting to read a staff-only file via direct API call gets 403 with no information leakage about the file's existence.
- Retention crypto-shred destroys zone keys cleanly on schedule; ciphertext remains on disk until the next backup rotation prunes it.
- Recovery-phrase export of an entire client vault completes in under 5 minutes for a 5 GB vault.
- All vault operations appear in `vault_audit_log` with actor + zone + timestamps.
