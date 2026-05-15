# ADR-028: Server-Side Encryption at Rest for Vibe File Transfer (Intake)

**Status:** Accepted
**Date:** 2026-05-13
**Context:** Vibe Connect Phase 28 — File Transfer / Intake addendum
**Deciders:** Kurt (Kisaes / KisaesDevLab)

## Context

Vibe Connect's core file-exchange model is end-to-end encrypted (E2EE) via libsodium XChaCha20-Poly1305. Files are encrypted on the client device with keys derived from authenticated users' credentials, and the server never holds plaintext or any key material that can decrypt them.

The Phase 28 intake feature introduces two requirements that are fundamentally incompatible with that model:

1. **Anonymous clients.** A walk-up client landing on `/intake` has no account, no credentials, and no key material the firm can validate. There is no key to wrap or unwrap with.
2. **Server-side image-to-PDF conversion.** Combining multiple scanned-image uploads into a single PDF, server-side, requires plaintext access to the images.

Either requirement alone defeats E2EE; together they make it unachievable on the intake path.

## Decision

Vibe File Transfer uploads are protected by **server-side encryption at rest with a firm-held libsodium key**, not end-to-end encryption.

Specifically:

- Transport: TLS via nginx (single-app mode) or external Caddy/Tunnel (multi-app mode); see CLAUDE.md "Distribution mode".
- At rest: every uploaded file, generated PDF, and PII column (client name, email, phone) is encrypted with libsodium secretbox / streaming secretbox using a 32-byte key held by the firm in environment variable `CONNECT_INTAKE_ENCRYPTION_KEY`. The 32-byte raw key IS the secretbox key — it is *not* HKDF-derived from SESSION_SECRET (which is the root for sealed provider creds, ACME account key, and other per-process material). Keeping the intake key independent means rotating it via the Phase 28.16 admin route does not invalidate sessions, sealed provider creds, or ACME state.
- The intake encryption key is **separate** from any per-user keys used elsewhere in Connect. It belongs to the firm, not to individual staff or clients.
- Conversion workers decrypt to a temp directory on the encrypted Docker volume, perform conversion, encrypt the result, and delete the temp files.
- All encryption and decryption is funneled through `apps/server/src/services/intakeCrypto.ts` (`encryptField`, `decryptField`, `encryptStream`, `decryptStream`, `hashForAudit`). Feature code never calls libsodium primitives directly — same rule as the rest of Connect ("**Do not inline nacl/crypto calls elsewhere**" in CLAUDE.md).

## Consequences

### Positive

- Image-to-PDF conversion is straightforward and runs on the server with no client-side complexity.
- Anonymous clients can upload without any account, key generation, or browser-side crypto.
- Staff can preview, search across, and bulk-download intake files via the standard Connect UI without per-session key dance.
- Recovery is operationally simple: holding the firm key and the encrypted volume backup is sufficient to restore any session.

### Negative — explicitly accepted

- **Not E2EE.** A server compromise that also exfiltrates the intake encryption key exposes all intake plaintext. This is the same threat model as virtually every other secure-file-transfer product (ShareFile, SmartVault, Verifyle's standard tier, etc.).
- **Distinct from Vault.** Connect's Client Vault remains E2EE. Operators and staff must understand that "files uploaded via intake" and "files in the Vault" have different cryptographic guarantees. This is documented in user-facing copy on `/intake` and in the firm admin guide.
- **Key rotation is non-trivial.** Rotating `CONNECT_INTAKE_ENCRYPTION_KEY` requires re-encrypting every stored file and every encrypted column. Tooling ships in Phase 28.16 as an admin HTTP route (`POST /admin/intake/rotate-key`) — *not* a CLI binary, since Connect has no CLI binary today. The rotation is resumable, dry-run-able, audit-logged, and SIGTERM-aware via the existing graceful-shutdown hook (`apps/server/src/index.ts:127-212`); maintenance mode (`firm_settings.intake_maintenance_mode`) blocks new uploads with 503 during the run.
- **Insider risk.** A staff member with database and disk access could in principle decrypt intake plaintext. This is mitigated by RBAC, audit logging of every decryption-on-view event (Phase 28.11 and 28.15), and the operational expectation that intake key material lives only on the appliance host.

### Why option 2 (client-side PDF assembly + E2EE upload) was rejected

- Browser-side PDF assembly of 10–20 high-resolution scanned pages is slow and memory-intensive on mid-tier mobile devices; the iPhone 8s and older Androids in actual CPA-firm client populations would struggle.
- OCR (already deferred) would have been permanently impossible under this model.
- Per-session key derivation for an anonymous client requires either password entry (terrible UX for a one-shot upload) or trust-on-first-use with key material in a URL fragment (fragile and creates link-sharing risks).
- Staff search across intake content becomes impossible without server decryption, removing a key feature of Phase 28.11.

### Why option 3 (hybrid) was rejected

- Doubles the implementation surface for marginal benefit.
- Forces staff to mentally track which sessions have which crypto guarantees when reviewing.
- The anonymous public path is the primary intake channel; tokenized links are a smaller fraction of volume, and giving them stronger crypto creates an inconsistent client experience.

## User-facing disclosure

The footer on `/intake` reads:

> "Files uploaded here are encrypted at rest. By proceeding you confirm the documents are yours to share. This page does not create an account."

The firm admin guide explicitly states that intake uploads use server-side encryption with a firm-held key and that this is distinct from Vault's end-to-end encryption.

## Revisit triggers

Reconsider this decision if any of the following change:

- A practical client-side PDF assembly path on low-end mobile becomes available with acceptable performance (sub-5s for 10 pages on a 4GB Android).
- A regulatory regime (e.g., a state-level CPA-firm data law) requires E2EE for inbound client data.
- Customer firms specifically request stronger guarantees and accept reduced functionality (no staff search, no server-side conversion).
