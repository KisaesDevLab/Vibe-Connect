# Vibe Connect — Phase 26 Build Plan: Client Vault

*Companion to `vibe-connect-build-plan.md` and `vibe-connect-phase-24-build-plan.md`. Phase 25 (SMS bridge) remains as planned. This addon adds per-client persistent E2EE file storage on top of the existing crypto, attachment, and notification infrastructure.*

---

## Context

The "scroll through chat to find the W-2 you sent in March" problem is real for every CPA firm running messaging-only document exchange. Conversations are message-ordered; engagement files are subject-ordered. Today, source documents, signed 8879s, prior-year returns, and workpapers all live as message attachments under whatever conversation happened to carry them — they age out of view, get duplicated when re-asked, and have no logical home that outlives a single tax year.

Phase 26 gives every `external_identity` a durable Client Vault: two zones (Shared + Staff-only), folders, files, retention, and audit — using the same crypto, the same ClamAV scan, the same firm-recovery model already shipped. Conversations and the vault are siblings under the client, not parent/child; a vault outlives any single engagement.

This plan **merges** the proposal in `vibe-connect-spec-client-vault.md` with what is actually shipped in the codebase as of 2026-04-24 (Phases 1–24 + Requests addon). It commits to specific decisions on the spec's seven open questions and corrects one explicit mismatch with the spec (tus protocol — the spec assumed it shipped in Phase 21; it didn't).

## Goal

Per-client durable E2EE file storage with Shared + Staff-only zones, reusing the existing wrap/rewrap key model, attachment driver, ClamAV pipeline, audit log, and notification stream. Server holds ciphertext only; staff-only zone keys are never deliverable to a client session.

## Scope (v1)

**In scope**

- One vault per `external_identity`, two zones (`shared`, `staff_only`)
- One level of folder nesting (root → folder; no sub-sub-folders)
- Upload, download, rename, move, soft-delete from staff and (Shared zone only) from portal
- Resumable chunked upload via tus protocol — new infrastructure, see § Upload Protocol
- ClamAV scan reused as-is; file-type allowlist extended for `.qbb`/`.qbm`/`.qbo`
- 250 MB per-file cap (vs 100 MB for messages)
- Folder templates per firm, auto-instantiated on client create or "new tax year" cron tick
- Per-folder retention with zone defaults; crypto-shred via key destruction on expiry
- Audit log for every privileged action
- Upload notifications via existing socket + pgFanout + email/SMS bridge
- Recovery-phrase emergency decrypt covers vaults

**Out of scope (v1, deferred to v2)**

- File versioning (`prior_version_id` reserved in schema, not exposed in UI)
- Encrypted client-side filename search (FlexSearch)
- E-sign integration / 8879 routing
- Email-in attachment routing to vault `Inbox/`
- Multi-client / joint-1040 vaults (`external_identity_group`)
- Sub-folder ACLs inside a zone (zone-only ACLs in v1)
- Folder nesting beyond one level
- Attach-to-message → vault-reference message type (compose UI in v1 still copies file in)

## Decisions committed in this plan

| Spec open decision | v1 commitment |
|---|---|
| Vault per client vs per engagement | **Per-client with engagement folders.** Avoids object multiplication; matches CPA mental model. |
| Client deletion rights | **Soft-delete with audit entry, configurable per firm via `firm_settings.vault_client_delete`.** Default on. |
| Max file size | **250 MB.** New env var `VAULT_MAX_FILE_BYTES` (default `262144000`). |
| Folder-level ACLs inside a zone | **Zone-only ACLs.** Folder ACLs deferred. |
| Multi-client matter (joint vault) | **Deferred to v2.** No `external_identity_group` schema in this phase. |
| Storage backend | **Single shared driver.** Vault uses `attachmentStorage()` (env: `ATTACHMENT_DRIVER`, `ATTACHMENT_LOCAL_DIR`, `S3_*`). No new `VAULT_STORAGE_*` family. |
| Retention granularity | **Per-folder, with zone defaults inherited from `firm_settings.vault_retention_*`.** |

## What already exists (reuse, do not rebuild)

Verified against the current tree at `apps/server/src/`:

- **Object storage** — `services/attachmentStorage.ts:19-119` exposes `attachmentStorage().put(key, buffer) → storage_path`, `.get(key) → Buffer`, `.delete(key)`. Local + S3 drivers. Sanitises keys (`sanitizeKey()` line 121-129). Vault reuses this directly with `vault-${vaultId}-${zoneId}-${Date.now()}-${randomBytes(8).toString('hex')}.bin` keys.
- **ClamAV** — `services/clamav.ts:23-78` `scanBuffer(buf) → {status: 'clean'|'infected'|'error'}`. Synchronous, fail-closed when `CLAMD_HOST` set, no-op (returns clean) otherwise. Vault reuses inline in upload route.
- **File-type allowlist pattern** — `routes/conversations.ts:699-717` (staff `STAFF_ALLOW_MIMES`) and `routes/portalUpload.ts:78-88` (portal `ALLOW_MIMES`). Extract to `services/mimeAllowlists.ts` and add `VAULT_STAFF_ALLOW_MIMES` (extends staff list with `application/vnd.intuit.quickbooks.backup` for `.qbb`, `.qbm`, `.qbo`).
- **Crypto primitives** — `packages/crypto/src/symmetric.ts` (`generateSymmetricKey`, `encryptMessage`, `decryptMessage`), `packages/crypto/src/asymmetric.ts:43-63` (`wrapKey`, `unwrapKey`), `packages/crypto/src/conversation.ts:22-93` (`createConversationKey`, `unwrapConversationKey`, `rotateConversationKey`, `incrementalWrap`, `rewrapForSameMembership`). Generic over recipients — no `conversation_id` coupling. Vault zone keys reuse all of these unchanged.
- **wrapped_keys recipient ID format** — `routes/conversations.ts:631-636`: `${userId}:${deviceId}` for staff devices, `client:${externalIdentityId}:session:${sessionId}` for portal sessions, `client:${externalIdentityId}:invite` for pre-activation, `firm:recovery` for recovery phrase. Vault zone keys use the same scheme.
- **Step-up gate** — `routes/portalConversations.ts:133-149`: returns `{stepupRequired: true, ...keys: null}` when `external_identity.verification_required && !session.verified_until`. Audit emits `portal.convkey_withheld_stepup`. Vault portal endpoints replicate this exactly with `portal.vaultkey_withheld_stepup`.
- **Internal-thread enforcement** — `routes/portalConversations.ts:123-127`: belt-and-suspenders 404 on `type IN ('internal_thread', 'internal')`. Vault staff_only zone uses the same pattern: portal vault endpoints 404 on any reference to `staff_only` zone, and `vaultKeysRepo.byVaultIdForSession()` filters out staff_only rows entirely.
- **Audit** — `repositories/audit.ts` `auditRepo.write({actor_user_id?, actor_external_identity_id?, action, target_type, target_id, details})`. Vault namespaces actions under `vault.*`.
- **Realtime fanout** — `realtime/pgFanout.ts` + `realtime/socket.ts` + `services/conversationService.ts:152-156` (`publish({type: 'conversation:rekey', ...})` pattern). Vault adds `vault:file-uploaded`, `vault:file-deleted`, `vault:rekey` event types. pgFanout subscriber needs vault scope-filter that emits to staff with conversation membership for the vault's `external_identity`.
- **Phase 24 module shape** — `routes/requests.ts` + `routes/portalRequests.ts` + `services/requestsService.ts` + `repositories/requests.ts` + tests in `__tests__/requests*.test.ts`. Vault mirrors this split: route → service → repository, Zod at the boundary, audit inside service, presenters base64-encode ciphertext fields.
- **Firm settings + admin route** — `routes/admin.ts:89-258` PATCH `/admin/settings`. Vault adds `vault_enabled`, `vault_client_delete`, `vault_max_file_bytes`, `vault_retention_*` to the same handler, with Zod and snake_case translation.
- **Scheduled message ticker** — `services/scheduledMessages.ts`. Reused for retention sweep cron (zone-key destruction).
- **Firm recovery phrase emergency decrypt** — already wraps to `firm:recovery` recipient ID across conversation_keys. Vault zone keys wrap to the same recipient automatically by reusing `createConversationKey()` with `firm:recovery` in the recipient list.

## What is new (build)

### 1. Upload Protocol — tus alongside multipart

Per decision: build tus for vault only; message attachments stay multipart. Reasons: 250 MB QuickBooks files are common, network drops cost a lot of re-upload bandwidth, and the vault is the natural place to introduce the protocol without retesting message flows.

**Server**

- New file `apps/server/src/services/tusServer.ts` wrapping `@tus/server` (add dep) with:
  - `FileStore` *replaced* by a custom `VaultStore` implementing `IDataStore` that buffers chunks to a temp file under `${ATTACHMENT_LOCAL_DIR}/tus-incoming/` then calls `attachmentStorage().put(...)` + `scanBuffer(...)` in the `onUploadFinish` hook.
  - Path: `POST /clients/:id/vault/uploads` for upload-creation; tus-protocol `PATCH/HEAD` continue against the returned upload URL.
  - Authn: reuse the `requireAuth` middleware for staff routes; reuse `loadSessionFromCookie` + step-up check for portal route `POST /portal/vault/uploads`.
  - tus metadata header carries `filenameCiphertext`, `wrappedFileKey`, `vaultId`, `folderId?`, `zone`, `mimeType`, `sizeBytes` (already client-encrypted).
  - On `onUploadFinish`: read assembled ciphertext from temp, scan with `scanBuffer`, on clean call `attachmentStorage().put(...)`, insert `vault_files` row, delete temp, emit `vault:file-uploaded`. Fail-closed on scan error (delete temp, return 503 in tus terminator hook).
- Resumable state stored in Postgres table `vault_uploads_in_progress` (id, upload_url_id, vault_id, zone, folder_id, expected_size, bytes_received, expires_at, created_by). 24h TTL; reaped by scheduled sweep.

**Client**

- `apps/web/src/components/VaultUploader.tsx` and `apps/portal/src/components/VaultUploader.tsx` use `tus-js-client` (already in `node_modules` as a dev dep — promote to direct dep). Encrypt file client-side with fresh per-file key, wrap key to zone key, then tus-upload the ciphertext.
- Progress states: `Encrypting → Uploading (resumable) → Scanning → Delivered` / `Blocked (virus)` — match the Phase 21 message-attachment UX strings for consistency.

### 2. Data model — five new tables + firm settings + ciphertext_meta keys

**Migration `20260426000001_client_vaults.js`** (forward + reverse):

```sql
client_vaults (
  id uuid pk default gen_random_uuid(),
  external_identity_id uuid not null references external_identities(id) on delete cascade,
  settings jsonb not null default '{}',           -- folder template id, retention overrides
  created_at timestamptz not null default now(),
  unique(external_identity_id)
)

vault_keys (
  id uuid pk,
  vault_id uuid not null references client_vaults(id) on delete cascade,
  zone text not null check (zone in ('shared','staff_only')),
  rotation_version integer not null,
  wrapped_keys jsonb not null default '{}',       -- {recipientId: wrappedKeyBase64}
  created_at timestamptz not null default now(),
  unique(vault_id, zone, rotation_version)
)

vault_folders (
  id uuid pk,
  vault_id uuid not null references client_vaults(id) on delete cascade,
  parent_folder_id uuid references vault_folders(id) on delete cascade, -- always null in v1 (one-level)
  zone text not null check (zone in ('shared','staff_only')),
  name_ciphertext text not null,                  -- base64 SymmetricEnvelope
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
)
create index idx_vault_folders_vault_zone on vault_folders(vault_id, zone) where deleted_at is null;

vault_files (
  id uuid pk,
  vault_id uuid not null references client_vaults(id) on delete cascade,
  folder_id uuid references vault_folders(id) on delete cascade,
  zone text not null check (zone in ('shared','staff_only')),
  filename_ciphertext text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_path text not null,
  wrapped_file_key bytea not null,
  envelope_format varchar(32) not null default 'vault-zone-key-v1',
  scan_status text not null default 'pending'
    check (scan_status in ('pending','clean','infected')),
  version integer not null default 1,
  prior_version_id uuid references vault_files(id),                -- reserved for v2
  uploaded_by_user_id uuid references users(id),
  uploaded_by_external_identity_id uuid references external_identities(id),
  uploaded_at timestamptz not null default now(),
  retention_expires_at timestamptz,
  deleted_at timestamptz,
  check ((uploaded_by_user_id is not null) <> (uploaded_by_external_identity_id is not null))
)
create index idx_vault_files_vault_folder on vault_files(vault_id, folder_id) where deleted_at is null;
create index idx_vault_files_scan_pending on vault_files(scan_status) where scan_status = 'pending';
create index idx_vault_files_retention on vault_files(retention_expires_at) where retention_expires_at is not null and deleted_at is null;

vault_audit_log (
  -- thin reference layer; the actual write goes through audit_log via auditRepo with target_type='vault_file'|'vault_folder'|'vault_zone'.
  -- Decision: do NOT add a separate table. Reuse the existing audit_log table; add a partial index for vault scopes.
)
create index idx_audit_log_vault on audit_log(target_id) where target_type in ('vault_file','vault_folder','vault_zone');

vault_uploads_in_progress (
  id uuid pk,
  upload_url_id text not null unique,             -- tus upload-id
  vault_id uuid not null,
  zone text not null,
  folder_id uuid,
  expected_size bigint not null,
  bytes_received bigint not null default 0,
  metadata jsonb not null default '{}',
  expires_at timestamptz not null,
  created_by_user_id uuid,
  created_by_external_identity_id uuid,
  created_at timestamptz not null default now()
)
```

**Migration `20260426000002_firm_vault_settings.js`** — `alter table firm_settings add column`:

```
vault_enabled boolean not null default true                       -- kill-switch
vault_client_delete boolean not null default true                 -- can clients delete their uploads?
vault_max_file_bytes bigint not null default 262144000            -- 250 MB
vault_retention_shared_days integer not null default 0            -- 0 = no auto-expiry
vault_retention_staff_days integer not null default 0
vault_folder_templates jsonb not null default '[]'                -- [{name, zone, retentionDays}, ...]
vault_new_year_cron_enabled boolean not null default false
```

**Migration `20260426000003_messages_ciphertext_meta_vault_keys.js`** — no schema change; documentation-only migration that records reserved keys on `messages.ciphertext_meta`:

- `vaultFileId` — when a system message announces a vault upload
- `vaultFolderId`
- `vaultZone` (`'shared'` only — staff_only events never appear in client-visible conversations)
- `systemEventType` extended with `'vault_file_uploaded'`, `'vault_file_deleted'`

`CLAUDE.md` § "Phase 24 deliberate exception" gets a parallel paragraph for Phase 26 listing these reserved keys.

**Seed `03_vault_folder_templates.js`** — idempotent default firm template (matches spec):

```js
[
  { name_template: 'Tax Year {YYYY}/Source Documents', zone: 'shared', retentionDays: null },
  { name_template: 'Tax Year {YYYY}/Workpapers',       zone: 'staff_only', retentionDays: null },
  { name_template: 'Tax Year {YYYY}/Final Deliverables', zone: 'shared', retentionDays: null },
  { name_template: 'Tax Year {YYYY}/Signed Forms',     zone: 'shared', retentionDays: 2555 }, // 7y
  { name_template: 'Permanent File',                   zone: 'staff_only', retentionDays: null },
  { name_template: 'Bookkeeping',                      zone: 'shared', retentionDays: null },
]
```

Folder names are encrypted by the staff client at template-apply time (template carries cleartext name templates; the apply step encrypts before insert into `vault_folders.name_ciphertext`). Same pattern as Phase 24 request templates (`apps/server/src/db/seeds/02_request_templates.js`).

### 3. Repositories — new modules

- `apps/server/src/repositories/vaults.ts` — exports `clientVaultsRepo`, `vaultKeysRepo`, `vaultFoldersRepo`, `vaultFilesRepo`, `vaultUploadsRepo`. Mirrors the shape of `repositories/requests.ts` (thin wrappers, buffers in/out, no business logic).
- Critical method: `vaultKeysRepo.byVaultIdForSession(vaultId, sessionRecipientId, zone)` — server enforces zone separation at the repo layer, never at the route layer alone. If `zone === 'staff_only'` and the recipientId starts with `client:`, returns `[]` regardless of caller. This is the hard invariant.

### 4. Services — vaultService + vaultUploadService

- `apps/server/src/services/vaultService.ts`
  - `ensureVaultForExternalIdentity(externalIdentityId, trx?) → ClientVault` — idempotent; called on first staff access.
  - `rotateZoneKey(vaultId, zone, newWrappedKeys, rotationVersion, trx?)` — server stores; client computes (mirrors `conversationService.addMember`).
  - `addStaffRecipient(vaultId, newWrappedKeys, rotationVersion)` — incremental wrap path on staff add.
  - `removeStaffRecipient(...)` — full rotation on staff remove.
  - `addClientSessionRecipient(vaultId, newWrappedKeys)` — Shared zone only. Server refuses to accept rotation for Staff-only zone if any `client:` recipient appears in `newWrappedKeys`.
  - `assertStaffMemberForVault(userId, vaultId)` — reuses conversation-membership check: staff who can see *any* conversation with this `external_identity` can see the vault, unless `firm_settings.vault_information_barrier === true` (deferred config; feature-flagged off in v1).
  - `presentVault(vault)`, `presentFolder(row)`, `presentFile(row)` — base64-encode ciphertext fields.
  - Audit emit points (action strings):
    `vault.created`, `vault.zone_rekeyed`, `vault.folder_created`, `vault.folder_renamed`, `vault.folder_moved`, `vault.folder_deleted`, `vault.folder_restored`, `vault.file_uploaded`, `vault.file_downloaded`, `vault.file_renamed`, `vault.file_moved`, `vault.file_deleted`, `vault.file_restored`, `vault.file_scan_failed`, `vault.zone_crypto_shredded`, `vault.emergency_decrypted`, `vault.export_recovery_phrase`, `vault.client_delete_blocked` (when firm config disallows).
- `apps/server/src/services/vaultUploadService.ts`
  - `onTusUploadFinish(uploadId, ciphertextBuffer)` — orchestrates scan → store → row insert → realtime publish → audit. Reuses `attachmentStorage()`, `scanBuffer()`, `auditRepo.write()`, `publish()`.
  - Concurrency/idempotency: a finished upload that is replayed (e.g. tus terminator races with finalize) checks for existing `storage_path` and short-circuits.
- `apps/server/src/services/vaultRetention.ts`
  - Cron tick scans `vault_files WHERE retention_expires_at < now() AND deleted_at IS NULL`; soft-deletes rows. When *every* file under a zone has been soft-deleted past a configured grace window AND the zone is closed (engagement marked complete), destroys the zone key by setting `vault_keys.wrapped_keys = '{}'` for that rotation_version and emits `vault.zone_crypto_shredded`. Bytes on disk become unreadable from that moment.
  - Hooks into the existing scheduled-job runner alongside `services/autoNudge.ts`.

### 5. Routes — staff + portal + tus

| File | Endpoint | Notes |
|---|---|---|
| `routes/vaults.ts` (new, staff) | `GET /clients/:id/vault` | Returns vault + folder tree + file list (ciphertext); both zones |
| | `POST /clients/:id/vault/folders` | Create folder |
| | `PATCH /clients/:id/vault/folders/:fid` | Rename / move |
| | `DELETE /clients/:id/vault/folders/:fid` | Soft delete |
| | `POST /clients/:id/vault/files` | Init tus upload, returns Location |
| | `GET /clients/:id/vault/files/:fid` | Stream ciphertext (range-aware) |
| | `PATCH /clients/:id/vault/files/:fid` | Rename / move |
| | `DELETE /clients/:id/vault/files/:fid` | Soft delete |
| | `POST /clients/:id/vault/files/:fid/versions` | v2 stub — returns 501 in v1 |
| | `POST /clients/:id/vault/rotate-keys` | Accepts `{zone, rotationVersion, wrappedKeys}` |
| | `POST /clients/:id/vault/templates/apply` | Apply firm folder template |
| | `POST /clients/:id/vault/emergency-decrypt` | Recovery-phrase-gated; mirrors existing emergency decrypt pattern |
| `routes/portalVault.ts` (new, portal) | `GET /portal/vault` | Shared zone only — server filters at repo |
| | `GET /portal/vault/folders/:fid/files` | Shared zone only |
| | `POST /portal/vault/files` | Init tus upload (Shared zone only); step-up enforced |
| | `GET /portal/vault/files/:fid` | Stream Shared-zone ciphertext |
| | `DELETE /portal/vault/files/:fid` | Iff `firm_settings.vault_client_delete` and uploader was this client |
| `routes/portalVaultUpload.ts` (new) | `PATCH/HEAD/DELETE /portal/vault/uploads/:uploadId` | tus protocol body for portal |
| `routes/vaultsUpload.ts` (new) | `PATCH/HEAD/DELETE /clients/:id/vault/uploads/:uploadId` | tus protocol body for staff |

Both tus tail routes delegate to a single `tusServer.ts` handler; the staff vs portal distinction is the auth wrapper applied before the handler.

Kill-switch: every vault route is wrapped with `requireVaultEnabled` (mirrors `requireRequestsEnabled` in `routes/requests.ts`). When `firm_settings.vault_enabled === false`, staff routes 403, portal routes return `{vaultDisabled: true}` (graceful degrade — same posture as Phase 24).

### 6. Realtime + notifications

- `realtime/pgFanout.ts` — add `vault:file-uploaded`, `vault:file-deleted`, `vault:rekey`. Subscribers: any user with conversation membership against the vault's `external_identity_id` (staff side) and the active client session (Shared zone events only).
- Push payloads: vault id, file id, actor id only — never filenames or content. Same hygiene as messages.
- Email + SMS bridge: client uploads to Shared zone trigger the existing scheduled-message pipeline with a system message (`source='system'`, `ciphertext_meta.systemEventType='vault_file_uploaded'`) so notifications ride the same delivery channels as Phase 24 nudges.

### 7. UI

**Staff app (`apps/web`)**

- New route `/clients/:id/files` reachable from:
  - Conversation header "Files" tab (`apps/web/src/components/ConversationView.tsx` — add tab)
  - Global Clients list (currently the page that lists `external_identities`) — add a per-row "Files" link
- Two-pane layout: folder tree (left) / file list (right). Tab toggle at top: **Shared** | **Staff-only**.
- Drag-and-drop upload, multi-select, rename, move (within same zone only).
- Per-file actions: Download, Set retention, View audit log, Soft delete.
- Upload from inside a conversation: small picker — "Send as message" (existing path) or "Save to client vault" (new tus path).

**Portal (`apps/portal`)**

- New nav item "Files" alongside "Messages" in `apps/portal/src/pages/AppShell.tsx` (or wherever the portal nav lives — verify).
- Shared zone only. Staff-only zone is invisible: no UI affordance, no count, no hint.
- Step-up gate: if `verification_required && !verified_until`, show step-up prompt before exposing the Files tab content. Reuses existing portal step-up flow.
- Upload, download, and (if `firm_settings.vault_client_delete`) delete-own-uploads.

### 8. Tests

Pattern matches Phase 24 (`apps/server/src/__tests__/requests*.test.ts`).

- `__tests__/vault-service.test.ts` — service-layer unit tests including:
  - **Zone separation invariant (critical)**: `vaultKeysRepo.byVaultIdForSession` returns empty for any `client:*` recipient against `staff_only`.
  - Step-up withholding parallels `convkey_withheld_stepup`.
  - Idempotent `ensureVaultForExternalIdentity`.
  - Rewrap on staff add/remove (incremental + full rotation paths).
- `__tests__/vault-routes.test.ts` — integration via Supertest:
  - Happy-path upload → scan-clean → row visible → realtime event observed.
  - **Adversarial portal**: client session attempts `GET /portal/vault?zone=staff_only` (rejected at validation); attempts to fetch a known `vault_files.id` belonging to staff_only zone (404 with no info leak).
  - **Adversarial staff**: staff with no conversation membership for the client tries to access vault (403).
  - tus resumable: chunked PATCH, server crash mid-upload, resume by HEAD + PATCH from `Upload-Offset`.
  - ClamAV `infected` and `error` paths fail-closed identically to messages.
- `__tests__/vault-retention.test.ts` — sweep produces correct soft-deletes and zone-key crypto-shred only after grace window + closed-engagement signal.
- `__tests__/vault-emergency-decrypt.test.ts` — recovery-phrase export of full vault; audit row written; export completes within budget for the test fixture (DOD: 5 GB in 5 min — measured against a smaller scaled fixture in CI).
- `packages/crypto` test vectors: `tests/vault-zone-key.test.ts` with deterministic vector confirming zone key wrap/unwrap round-trip across all four recipient ID forms (staff device, client session, invite, recovery).

### 9. Documentation

- New `docs/ops/VAULT.md` — admin runbook (firm settings, retention, emergency decrypt, peer-review export).
- New `docs/ops/VAULT_CLIENT.md` — client-facing portal usage (step-up, upload, delete).
- Update `CLAUDE.md`:
  - Add Phase 26 reserved keys for `messages.ciphertext_meta`
  - Add Phase 26 grep anchors and audit action prefix `vault.*`
- Update `docs/THREAT_MODEL.md` — explicitly call out the ClamAV-sandbox plaintext window for vault files (don't rely on attachment language to imply it). Document side-channel: file size, mime, upload timestamp remain plaintext metadata.
- Append a "Phase 26 — Client Vault" section to `vibe-connect-build-plan.md` under "Suggested ordering & parallelism" so the master plan reflects the new phase.

## Critical files to be created/modified

**Created**

- `apps/server/src/db/migrations/20260426000001_client_vaults.js`
- `apps/server/src/db/migrations/20260426000002_firm_vault_settings.js`
- `apps/server/src/db/migrations/20260426000003_messages_ciphertext_meta_vault_keys.js`
- `apps/server/src/db/seeds/03_vault_folder_templates.js`
- `apps/server/src/repositories/vaults.ts`
- `apps/server/src/services/vaultService.ts`
- `apps/server/src/services/vaultUploadService.ts`
- `apps/server/src/services/vaultRetention.ts`
- `apps/server/src/services/tusServer.ts`
- `apps/server/src/services/mimeAllowlists.ts` *(extracts existing constants from conversations.ts + portalUpload.ts)*
- `apps/server/src/routes/vaults.ts`
- `apps/server/src/routes/vaultsUpload.ts`
- `apps/server/src/routes/portalVault.ts`
- `apps/server/src/routes/portalVaultUpload.ts`
- `apps/server/src/__tests__/vault-service.test.ts`
- `apps/server/src/__tests__/vault-routes.test.ts`
- `apps/server/src/__tests__/vault-retention.test.ts`
- `apps/server/src/__tests__/vault-emergency-decrypt.test.ts`
- `apps/web/src/pages/ClientFiles.tsx`
- `apps/web/src/components/VaultUploader.tsx`
- `apps/web/src/components/VaultFolderTree.tsx`
- `apps/web/src/components/VaultFileList.tsx`
- `apps/portal/src/pages/Files.tsx`
- `apps/portal/src/components/VaultUploader.tsx`
- `packages/crypto/tests/vault-zone-key.test.ts` *(or wherever existing crypto vectors live)*
- `docs/ops/VAULT.md`, `docs/ops/VAULT_CLIENT.md`
- `vibe-connect-phase-26-build-plan.md` *(repo-checked-in copy of this plan, on approval)*

**Modified**

- `apps/server/src/index.ts` — register new routers + tus endpoints
- `apps/server/src/app.ts` — wire kill-switch middleware
- `apps/server/src/realtime/pgFanout.ts` — add `vault:*` event types
- `apps/server/src/services/conversationService.ts` — when conversation member added/removed, also publish a hook that triggers vault zone-key rewrap if the member's external_identity has a vault (server-side signal only; clients perform the actual rewrap)
- `apps/server/src/routes/admin.ts` — add `vault_*` settings to PATCH /admin/settings (Zod + snake_case)
- `apps/server/src/routes/conversations.ts` and `apps/server/src/routes/portalUpload.ts` — extract `STAFF_ALLOW_MIMES` / `ALLOW_MIMES` to `services/mimeAllowlists.ts`
- `apps/web/src/pages/AppShell.tsx` and `apps/web/src/components/ConversationView.tsx` — add Files entry points
- `apps/portal/src/pages/AppShell.tsx` (or equivalent shell) — add Files nav
- `apps/web/src/state/crypto.tsx` — extend unwrap path with vault zone keys (mirrors conversation key unwrap, line 360-494)
- `apps/portal/src/api.ts` — add vault endpoints
- `packages/shared-types/src/index.ts` — `Vault`, `VaultFolder`, `VaultFile`, `VaultZone`, realtime event payloads
- `package.json` (root + `apps/server` + `apps/web` + `apps/portal`) — promote `tus-js-client` to direct dep; add `@tus/server`
- `CLAUDE.md` — Phase 26 reserved keys + anchors
- `docs/THREAT_MODEL.md` — vault plaintext-window + side-channel
- `vibe-connect-build-plan.md` — Phase 26 entry under ordering + timeline

## Build order (suggested sequencing)

1. **26.1 Schema + repos** (1–2 days). Migrations, seed, repositories. Land with tests for `vaultKeysRepo.byVaultIdForSession` zone-separation invariant.
2. **26.2 Crypto + service layer** (2–3 days). `vaultService` create/rotate/recipient flows, presenters, audit. Zone-separation tests pass without any HTTP layer.
3. **26.3 tus infrastructure** (3–4 days). `tusServer.ts` + `vaultUploadService` + `vault_uploads_in_progress` reaper. Resumable test passes.
4. **26.4 Staff routes + admin settings** (2 days). All `/clients/:id/vault/*` endpoints, kill-switch, audit emission. Integration tests pass.
5. **26.5 Portal routes** (1–2 days). Step-up gate replicated, Shared-zone-only filter at repo, `vault_client_delete` toggle.
6. **26.6 Staff UI** (3–4 days). `ClientFiles.tsx` + tree/list components + uploader.
7. **26.7 Portal UI** (2 days). Files nav + page + uploader.
8. **26.8 Notifications + realtime** (1–2 days). pgFanout extension, system message emission, email/SMS bridge integration.
9. **26.9 Retention + emergency decrypt** (2 days). Cron sweep, crypto-shred, recovery-phrase export.
10. **26.10 Docs + threat-model + master-plan update** (1 day).

Estimated total: **3–4 weeks** for one developer with Claude Code assistance, parallelisable into ~2 weeks if UI and server tracks split.

Phase 25 (SMS) remains unchanged in the master plan; Phase 26 can ship in parallel with Phase 25 since they share no surface area beyond the scheduled-message ticker, which already exists.

## Verification

End-to-end checks before marking the phase done:

1. **Fresh appliance install + seed** — vault tables exist, default folder template seeded, `firm_settings.vault_*` defaults applied. Run: `yarn workspace @vibe-connect/server knex:migrate:latest && yarn workspace @vibe-connect/server knex:seed:run`.
2. **Staff happy path** — log in as staff, navigate to a client, click Files, create a Shared folder, drag-drop a 50 MB PDF, observe Encrypting → Uploading → Scanning → Delivered. Confirm row in `vault_files`, ciphertext on disk under `${ATTACHMENT_LOCAL_DIR}/attachments/`, `audit_log` row with action `vault.file_uploaded`.
3. **Portal happy path** — log in as client portal session, complete step-up, upload a W-2, observe in staff Files view within 10 seconds. `audit_log` shows uploader as `external_identity_id`.
4. **Zone separation (adversarial)** — using a portal session token, hit `GET /clients/:id/vault?zone=staff_only` directly via curl. Expect 404 with no info leak. Inspect server logs and `audit_log` for the rejected attempt.
5. **tus resumable** — start a 200 MB upload, kill the network mid-stream, resume; final scan + insert succeed exactly once. Verify no orphaned temp files in `tus-incoming/` after success and after deliberate failures.
6. **ClamAV fail-closed** — upload an EICAR test signature; scan returns infected, row marked, blob deleted, 422 returned, audit `vault.file_scan_failed`. Stop ClamAV, retry a clean upload; expect 503 with audit; bring ClamAV back up; retry succeeds.
7. **Step-up gate** — clear `verified_until` on a portal session via SQL; portal Files tab shows step-up prompt; vault key endpoint returns `{stepupRequired: true}` with no wrapped keys.
8. **Staff add/remove rewrap** — add a new staff user to the firm, observe new `vault_keys` rotation_version row with that user's wrapped key; remove a staff user, observe full rotation with old user's wrapped key absent.
9. **Recovery-phrase emergency export** — exercise `POST /clients/:id/vault/emergency-decrypt` with the firm recovery phrase; verify decrypted bundle for a 1 GB fixture vault; audit row written with `vault.emergency_decrypted` and exporter user id.
10. **Retention crypto-shred** — set `retention_expires_at` to past on test files, run sweep, verify soft-deletes; mark engagement closed, run sweep again, verify zone-key rotation row's `wrapped_keys` becomes `{}` and audit `vault.zone_crypto_shredded` written. Attempt to download a file under that zone — fails to decrypt (key gone) even though ciphertext bytes still on disk until next backup prune.
11. **Test suite green** — `yarn workspace @vibe-connect/server test`, `yarn workspace @vibe-connect/web test`, `yarn workspace @vibe-connect/portal test`, `yarn workspace @vibe-connect/crypto test`. Lint + typecheck across all workspaces.
12. **Smoke boot of docker-compose** — vault routes register, ClamAV reachable, tus upload from staff browser succeeds against the appliance image.

Definition of done aligns with the spec's Definition of done (v1) verbatim — those six bullet points become the acceptance criteria for shipping the phase.

## Threat-model deltas (recorded in `docs/THREAT_MODEL.md`)

- **Plaintext window**: identical to message attachments — ClamAV scan is the moment ciphertext-decrypted-into-buffer exists in server memory. `tus-incoming/` temp files are *ciphertext* (client-side encrypted before tus transmits), so no on-disk plaintext window.
- **Side-channel leakage**: `vault_files.size_bytes`, `mime_type`, `uploaded_at`, folder structure, and folder counts remain plaintext metadata. A staff member with DB access can infer engagement activity. Acceptable under firm-trust model; documented.
- **Client-uploaded malware**: ClamAV + extended file-type allowlist (`.qbb`/`.qbm`/`.qbo` added). `application/octet-stream` allowed only for staff uploads, not portal.
- **tus state-of-upload theft**: `vault_uploads_in_progress.upload_url_id` is sufficient to resume an upload. Bind to creator (`created_by_user_id` / `created_by_external_identity_id`) and reject PATCH from a different session. 24h TTL plus aggressive reaping.

## Out of this plan (explicitly)

- Renumbering Phase 24 in the master plan (the original Phase 24 was the side-thread; Phase 24 was reused for Requests). Out of scope here; if it bothers, a doc-cleanup PR can renumber separately.
- Migration of existing message attachments into the vault. Conversations and the vault remain siblings; old attachments stay in `attachments`. A future "promote-to-vault" action on a single attachment can be added later — not v1.
- Object multiplication for joint-1040 spouses. v2 problem.
- Replacing message-attachment uploads with tus. Stays multipart in v1.
