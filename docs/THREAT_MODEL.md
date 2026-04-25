# Vibe Connect — Threat Model

## Assets

| Asset | Sensitivity | Where it lives |
|-------|-------------|----------------|
| Staff-to-staff message content | High | Ciphertext at rest (Postgres `messages.ciphertext`), plaintext only in authenticated staff browsers/desktop apps |
| Staff-to-client conversation content | High | Ciphertext at rest, plaintext only in staff devices + authenticated+verified client sessions |
| Client SSN / EIN last-4 | High | bcrypt hash only (`external_identities.verification_last4_hash`) |
| Firm recovery phrase | Critical | Paper / sealed envelope held by the managing partner; NEVER in the server, DB, or backups |
| Firm master private key | Critical | Wrapped by the phrase-derived key; stored in `firm_keys.encrypted_recovery_private_key`; cached in server memory after install for convenience |
| Staff device private keys | High | Wrapped by Argon2id-derived key from the user's password; stored in `user_keys.encrypted_private_key` and in the browser's IndexedDB |
| Client session tokens | High | Server-side in `client_sessions`; hashed before storage |
| Access codes (email / SMS OTP) | Medium | bcrypt'd; short-lived |
| Attachment ciphertext | High | On disk under the appliance's `uploads` volume |
| Audit log | Medium | `audit_log` — not encrypted, but never contains message content |

## Actors

1. **Legitimate staff user** — authenticates with username + password; device key unlocks per session; sees the decrypted plaintext of conversations they belong to.
2. **Legitimate client** — authenticates with email/phone + access code; may need SSN/EIN step-up; sees only plaintext of their own conversations.
3. **Managing partner with recovery phrase** — can decrypt ANY conversation including client ones, for audit / subpoena / peer review. Audit-logged.
4. **Network attacker (passive)** — sees ciphertext in transit (TLS-terminated ciphertext bundles); cannot decrypt.
5. **Network attacker (active)** — may attempt MITM; defeated by TLS + same-origin cookie; Socket.io events are ciphertext-only.
6. **Server-level attacker** — has DB read; sees ciphertext + wrapped keys. Without a staff device password or the recovery phrase, cannot read plaintext.
7. **Server-level attacker (root)** — can add wrapped keys for themselves going forward. Detection: audit log + device health; mitigation: short session cookie lifetime + device revocation.
8. **Departing staff member** — admin revokes their device; subsequent conversation-key rotation ensures new messages are unreadable to them.
9. **Lost device** — admin revokes; device's wrapped keys are rotated out of `conversation_keys.wrapped_keys`.
10. **Lost recovery phrase** — permanent loss of emergency decryption for external conversations. Documented as non-recoverable.

## Trust boundaries

```
  Browser / PWA / Tauri                Server                          Postgres
  ┌────────────────┐   TLS       ┌───────────────┐   libpq (TLS)   ┌──────────────┐
  │ plaintext UI   │────────────▶│ ciphertext API │────────────────▶│ ciphertext +│
  │ device secret  │             │ session-auth   │                 │ wrapped keys │
  │ wrapped keys   │             │ no plaintext   │                 │ audit log    │
  └────────────────┘             └───────────────┘                 └──────────────┘
                                         │
                                         └─ Email / SMS bridges (plaintext window at gateway receipt,
                                            encrypted with conversation key before persistence)
```

## Cryptographic primitives (see `packages/crypto`)

- Symmetric (message + attachment): **XChaCha20-Poly1305** (`libsodium.crypto_aead_xchacha20poly1305_ietf_*`) — 256-bit key, 192-bit nonce.
- Password-wrapped private keys: **`crypto_secretbox_easy`** (XSalsa20-Poly1305) using an **Argon2id13**-derived key (ops=3, mem=256 MiB, 32-byte output).
- Key agreement / recipient wrap: **X25519 `crypto_box_seal`** (anonymous sealed box) — authenticated by the sealed-box MAC; we don't additionally sign.
- Recovery phrase: **BIP-39 24-word** via the `bip39` npm package (canonical English wordlist, SHA-256 checksum).
- Phrase → wrapping key: `generichash(32, entropy, salt)` (BLAKE2b-256) — intended as a strengthening step only; the phrase itself has 256 bits of entropy.

## Properties claimed

1. **Server never sees plaintext.** All primitives that produce plaintext run in `packages/crypto` inside the browser / Tauri webview / (for bridge incoming only) the server's gateway handler just long enough to wrap with the conversation key.
2. **Confidentiality against passive server attacker.** The DB contains ciphertext + wrapped keys. Without a staff device password, a client SSN/EIN, or the recovery phrase, all messages are unreadable.
3. **Integrity + authenticity against tampering.** XChaCha20-Poly1305 + `crypto_box_seal` both provide AEAD; any byte-level tamper produces a decryption failure.
4. **Forward secrecy is NOT claimed.** Conversation keys persist for their rotation window. Rotation on member removal limits blast radius but older ciphertext stays readable by anyone who still has the v1 wrapped key.
5. **Emergency access.** Managing partner's recovery phrase recovers the firm master private key, which can unwrap any conversation key that has a `"firm"` entry in `wrapped_keys`. Every conversation is required to include this entry for compliance.
6. **Bridged messages are NOT end-to-end** from the original sender. Email/SMS-in arrives plaintext at the bridge webhook; it is encrypted with the conversation key immediately and the row is tagged `source='email-in' | 'sms-in'`. UI must display the source indicator.
7. **Firm recovery phrase is NOT in backups.** The appliance image + Postgres dump + uploads volume are enough to restore a running server but cannot decrypt external conversations without the phrase. Documented in `docs/ops/BACKUP_RECOVERY.md`.

## Non-goals

- **Zero-knowledge.** We explicitly DO have firm-side emergency access; we never advertise otherwise.
- **Post-compromise security for bridged channels.** Email / SMS metadata is not encrypted.
- **Forward secrecy of prior messages.** Covered above.
- **Protection against a compromised end-user device.** If the staff workstation is rooted, the attacker has the unlocked device key. We rely on the admin's device revocation + key rotation to mitigate going forward.

## Specific concerns the reviewer should verify

1. The `secretbox` nonce is always a fresh `randombytes_buf(NONCEBYTES)`. (`packages/crypto/src/symmetric.ts`)
2. XChaCha20 nonces are fresh per-message. (Same file.)
3. Argon2id parameters in `kdf.ts` are reasonable for 2025+ workstation hardware (ops=3, mem=256 MiB). Increase if benchmarks show < 250 ms unlock is too fast.
4. The BIP-39 phrase is generated from a CSPRNG (`libsodium.randombytes_buf`) via the `bip39` package — the package uses Node's crypto in Node and `window.crypto` in the browser.
5. The `"firm"` wrapped-key slot must be present in every conversation_keys row. There is no runtime enforcement; the client SDK is expected to include it. Operational recommendation: add a CI check that inserts a "firm"-less row and asserts policy + runtime test.
6. Device-public-key storage is base64; nothing stops an attacker with DB write from swapping the public key. Mitigation: audit-log on enroll + admin "verify fingerprint" flow (future phase).
7. We do not sign messages. The recipient trusts that the conversation key unwrap succeeded → plaintext is authentic because only members were given wrapped keys. If the server is actively malicious and injects a wrapped key for itself, it can read (not forge) going forward. Forgery protection requires sender signing; out of scope for v1.

## Phase 26 — Client Vault deltas

The vault inherits the wrap/rewrap key model from conversation_keys; the
deltas worth flagging:

- **Plaintext window.** Same as message attachments — the buffer that
  ClamAV scans exists in process memory for the scan duration. The
  `tus-incoming/` partial files on disk are ciphertext throughout (the
  client encrypts with a per-file key wrapped to the zone key before tus
  transmits the first byte), so there is no on-disk plaintext window.
- **Side-channel leakage.** `vault_files.size_bytes`, `mime_type`,
  `uploaded_at`, folder structure, and folder counts remain plaintext
  metadata. A staff member with DB access can infer engagement activity
  from size patterns. Acceptable under the firm-trust model; documented
  here so it isn't surprising.
- **Client-uploaded malware.** Clients are not a privileged threat actor,
  but the upload path is a direct attack surface. ClamAV plus the
  file-type allowlist in `apps/server/src/services/vaultUploadService.ts`
  is the v1 mitigation. `application/octet-stream` is allowed for staff
  uploads only — portal callers cannot send it.
- **tus state-of-upload theft.** The `vault_uploads_in_progress.upload_url_id`
  is sufficient to resume an upload. The row is bound to its creator
  (`created_by_user_id` / `created_by_external_identity_id`) and PATCH
  from a different session is rejected with 403. 24h TTL; the vault
  retention sweep reaps stale rows + orphaned partial files hourly.
- **Hard zone-separation invariant.** `staff_only` wrapped keys are never
  delivered to a `client:*` recipient. Enforcement at the repository layer
  (`vaultKeysRepo.byVaultIdForSession`); route-layer 404 is the
  second-line defense and returns no info on the existence of a
  staff-only file id. Tested directly with adversarial integration cases.
- **Recovery-phrase emergency export.** Audited every time. Audit row
  records `actor_user_id`, `target_id` (vault id), `details` (zones
  unlocked, file count), and the partner's IP. Compliance reviewers
  should verify these rows match an authorised access request.

## Phase 27 — Message edit / delete / timed self-destruct deltas

This phase adds three sender-side message-lifecycle controls. None of them
relax the existing "server holds ciphertext only" property; the new state
columns + history table are still ciphertext at rest.

- **Edit history is admin-recoverable plaintext potential, not extra
  ciphertext exposure.** `message_edits` rows hold the prior ciphertext +
  ciphertext_meta + content_key_version, encrypted under whatever
  conversation-key version was live at the time. Decryption requires the
  same wrap chain a normal message read does. The new `GET
  /admin/messages/:id/history` endpoint returns the bundle for offline /
  in-browser decrypt; rate-limited 30/hr/admin and audit-logged
  (`admin.message_history_viewed`).
- **"Self-destruct after view" is best-effort.** The server purges
  ciphertext on schedule (soft-delete at `destruct_at`; later crypto-shred
  via the existing retention path). It cannot reach plaintext that already
  rendered on a recipient device — FlexSearch index entries, scrollback
  buffer, screenshots, copy/paste, terminal logs, OS-level swap. Compose
  UI surfaces this as "Self-destruct after viewed (best-effort)" and the
  Admin → Settings copy spells out the cached-plaintext caveat. We do NOT
  advertise self-destruct as a confidentiality control beyond the server
  data-at-rest boundary.
- **Soft-delete preserves ciphertext for admin recovery.** Same trade-off
  as the edit-history table: a staffer who deletes a sloppy message has
  not removed the audit-relevant content. Recipients see "Message deleted"
  in the bubble. Crypto-shred runs later via retention if the firm has
  configured a retention window short enough to claim the row.
- **Read-receipt is the destruct-arming signal.** `messages.destruct_at`
  is stamped by the read endpoint when the first non-sender marks the
  message read. The stamp UPDATE uses `WHERE destruct_at IS NULL` to
  guarantee idempotency under concurrent reads (multi-tab portal client).
  Sender self-reads are filtered server-side by comparing `sender_id`
  against the reader's user id; for portal readers the sender is by
  construction a staff user (clients post via `sender_external_identity_id`
  only) so the predicate becomes a safe no-op.
- **Edit + delete remain staff-only.** The PATCH/DELETE routes already
  required `sender_id === req.session.userId`. Client portal posts have
  `sender_id IS NULL` (they write via `sender_external_identity_id`), so
  the equality check naturally rejects every client edit/delete attempt.
  No new permission code path was added; the gate is still load-bearing.
- **Concurrent destruct claim.** The `destructMessages.runOnce()` ticker
  uses a single `UPDATE ... RETURNING` to claim and soft-delete in one
  statement. Two ticks (or two server instances) racing on the same row
  produce one winner; no double audit, no double broadcast. Failure to
  broadcast does NOT roll back the soft-delete (recipients pick up the
  change on their next list fetch); contrast with the
  scheduled-message ticker, which DOES roll back, because the broadcast
  IS the visible effect there.
- **Bridged-message recall is not promised.** A staffer can soft-delete a
  bridged-out message in the staff thread, but the email already left the
  outbound queue. The compose UI does not yet refuse the destruct
  dropdown for conversations with active bridge-out — left as a follow-up
  improvement; admins should treat self-destruct on `external`
  conversations as in-product only.

## Questions for the reviewer

- Is the sealed-box wrap (no signing) adequate for our trust model, or should we move to signed pre-keys?
- Are the Argon2id parameters appropriate, or should we bump `opsLimit` and accept a slower unlock?
- Does the BIP-39 checksum derivation via the `bip39` npm package match the spec bit-for-bit?
- Is the "firm" slot enough for emergency decryption without opening a side channel that defeats the "ciphertext-only at the server" claim?
- Is `crypto_secretbox_easy` acceptable for private-key wrapping given Argon2id-derived keys, or should we standardize on XChaCha20-Poly1305 there too?

Sign-off on these questions + no unresolved critical/high findings gates Phase 17 (rollout).
