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

## Questions for the reviewer

- Is the sealed-box wrap (no signing) adequate for our trust model, or should we move to signed pre-keys?
- Are the Argon2id parameters appropriate, or should we bump `opsLimit` and accept a slower unlock?
- Does the BIP-39 checksum derivation via the `bip39` npm package match the spec bit-for-bit?
- Is the "firm" slot enough for emergency decryption without opening a side channel that defeats the "ciphertext-only at the server" claim?
- Is `crypto_secretbox_easy` acceptable for private-key wrapping given Argon2id-derived keys, or should we standardize on XChaCha20-Poly1305 there too?

Sign-off on these questions + no unresolved critical/high findings gates Phase 17 (rollout).
