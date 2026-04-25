# Client Vault — Admin Runbook

Phase 26. Per-client durable E2EE file storage with two zones (Shared,
Staff-only). Sibling to conversations under the client; not parent/child.
A vault outlives any single engagement.

## Crypto split (load-bearing)

- File bytes: client-encrypted with a fresh per-file XChaCha20-Poly1305 key,
  wrapped to the zone key. Server stores ciphertext only.
- Filenames: encrypted under the zone key (libsodium secretbox). Server
  stores `filename_ciphertext` as a base64 string.
- Folder names: same as filenames.
- Plaintext metadata: `mime_type`, `size_bytes`, `uploaded_at`, folder
  structure, scan status. Same compromise as message attachments.
- Zone keys: per-zone (`shared`, `staff_only`), wrapped per recipient in
  `vault_keys.wrapped_keys`. Recipient ID format mirrors `conversation_keys`:
  - `${userId}:${deviceId}` — staff device
  - `client:${externalIdentityId}:session:${sessionId}` — portal session
  - `client:${externalIdentityId}:invite` — pre-activation invite
  - `firm:recovery` — firm recovery phrase
- Hard zone-separation invariant: `staff_only` wrapped keys are never
  delivered to any `client:*` recipient. Enforced at the repository
  (`vaultKeysRepo.byVaultIdForSession`) and at portal route handlers
  (404 with no info leak).

## Firm settings (admin → Settings)

| Field | Default | Notes |
| --- | --- | --- |
| `vault_enabled` | `true` | Kill switch. Disable hides the staff Files tab and returns 403/`vaultDisabled:true` from every endpoint. Existing data is preserved. |
| `vault_client_delete` | `true` | Lets clients soft-delete their own uploads. Off pins delete to staff. |
| `vault_max_file_bytes` | `262144000` (250 MB) | Cap enforced by tus `Tus-Max-Size`. Bigger than the 100 MB message-attachment cap to handle QuickBooks `.qbb` and full-K-1 tax PDFs. |
| `vault_retention_shared_days` | `0` (no auto-expiry) | Per-zone default; per-folder retention overrides. |
| `vault_retention_staff_days` | `0` | Same as above. |
| `vault_folder_templates` | seed default | JSON array of `{nameTemplate, zone, retentionDays?}`. `{YYYY}` substitutes the engagement year on apply. |
| `vault_new_year_cron_enabled` | `false` | Auto-instantiate new-year folders. |
| `vault_information_barrier` | `false` | When true, staff need explicit per-client grant. v1 has no grant UI; toggle locks all staff out. |

## Authorization rules

- Staff: any user with at least one non-removed conversation membership
  against the client's `external_identity` can see both zones. Tighten via
  `vault_information_barrier` (v2 grant flow).
- Portal client: shared zone only, gated by SSN/EIN step-up. Server
  refuses every endpoint with `stepup_required` until verification is
  satisfied. Same gate as conversation key delivery.
- Recovery-phrase emergency decrypt: admin only. Audited with vault id +
  zones unlocked + file count.

## Audit actions

All `vault.*` rows ride the existing `audit_log` table; `target_type`
distinguishes scope: `'vault'`, `'vault_file'`, `'vault_folder'`,
`'vault_zone'`. A partial index keeps "everything that happened to this
file/folder/zone" cheap.

| Action | Target | Notes |
| --- | --- | --- |
| `vault.created` | vault | First-staff-access creates lazily. |
| `vault.zone_rekeyed` | vault_zone | Full rotation (member add/remove, manual). |
| `vault.zone_recipient_added` | vault_zone | Incremental wrap (single new recipient). |
| `vault.folder_created/renamed/moved/deleted/restored` | vault_folder | |
| `vault.file_uploaded` | vault_file | After ClamAV verdict 'clean'. |
| `vault.file_downloaded` | vault_file | Per download — high cardinality. |
| `vault.file_renamed/moved/deleted/restored` | vault_file | |
| `vault.file_scan_failed` | vault | Reason: `infected` (with signature) or `scan_error`. |
| `vault.zone_crypto_shredded` | vault_zone | Retention sweep destroyed wrapped keys. |
| `vault.emergency_decrypted` | vault | Recovery-phrase export. |
| `vault.client_delete_blocked` | vault_file | Portal delete refused. |
| `portal.vaultkey_withheld_stepup` | vault | Portal client missing valid step-up. |

## Retention

- Per-folder `retention_expires_at` set by staff.
- Hourly sweep (`services/vaultRetention.ts`) soft-deletes expired files.
- After a 30-day grace period with no live files in a zone, the zone's
  `wrapped_keys` map is zeroed (`vault_keys.cryptoShred`). Bytes-on-disk
  remain until backup prune; without the wrapped key they're unreadable.
- Manual force-shred for emergency: directly UPDATE
  `vault_keys SET wrapped_keys = '{}' WHERE vault_id = $1 AND zone = $2`
  + a manual audit row.

## Emergency decrypt (recovery phrase)

`POST /clients/:id/vault/emergency-decrypt` (admin only) returns:

```jsonc
{
  "vaultId": "...",
  "recoveryBundles": [
    {
      "zone": "shared" | "staff_only",
      "rotationVersion": 1,
      "wrappedRecoveryKey": "<base64 sealed-box of zone key under firm recovery pubkey>"
    }
  ],
  "files": [
    { "id": "...", "zone": "...", "filenameCiphertext": "...", "wrappedFileKey": "...", "mimeType": "...", "sizeBytes": 1234, ... }
  ]
}
```

The partner unwraps `wrappedRecoveryKey` locally with the recovery secret
key derived from the 24-word phrase, then unwraps each file's
`wrappedFileKey` and downloads ciphertext via `GET /clients/:id/vault/files/:fid`.
The audit row records `actor_user_id`, `target_id` (vault), `details`
(zones unlocked, file count), and the partner's IP.

## tus uploads

Resumable. `POST /clients/:id/vault/uploads` to create, `PATCH/HEAD/DELETE
/clients/:id/vault/uploads/:uploadId` to continue. Upload state lives in
`vault_uploads_in_progress`; partial files in `${ATTACHMENT_LOCAL_DIR}/tus-incoming/`.
Bound to the creator session — a different cookie can't resume.

24-hour TTL on incomplete uploads; reaped hourly by the same retention
ticker.

## Verification (DOD)

1. Staff happy path: upload 50 MB PDF in Shared zone, scan-clean, row in
   `vault_files`, ciphertext on disk, audit row written.
2. Portal happy path: client uploads with valid step-up, file appears in
   staff Files view within ~10 seconds (socket fanout).
3. Adversarial portal: hit `GET /portal/vault/files/<staff-only-id>` →
   404 with no info leak. `audit_log` shows the rejection.
4. tus resumable: 200 MB upload, kill network mid-stream, resume; final
   row inserted exactly once.
5. ClamAV fail-closed: EICAR test → 422, audit `vault.file_scan_failed`.
6. Step-up gate: clear `verified_until` → portal Files tab returns
   `stepupRequired: true`.
7. Crypto-shred: set `retention_expires_at` past, run sweep, zone keys
   zeroed after grace. Download fails to decrypt.
8. Recovery export: 1 GB fixture vault unwraps via partner's phrase under
   5 minutes, audit captures it.
