# Security Review Scope — Vibe Connect

For the 1–2 week, $3–6k engagement called for in Phase 16 of the build plan.

## Goal

Independent, crypto-literate review of:
1. Key generation, storage, wrapping/unwrapping, rotation, recovery.
2. The Argon2id parameters, the wrapping formats.
3. Any custom protocol elements (conversation-key wrap, emergency access, BIP-39 use).
4. The threat model (`docs/THREAT_MODEL.md`).

## In scope

### Files
- `packages/crypto/src/*.ts` — every primitive and every public API.
- `packages/crypto/src/__tests__/*.ts` — test vectors and round-trip proofs.
- `apps/server/src/routes/conversations.ts` — conversation + member + message routes (how ciphertext flows).
- `apps/server/src/routes/admin.ts` — `/admin/export` (emergency audit decryption path).
- `apps/server/src/routes/firstBoot.ts` — firm key install (one-shot, recovery phrase display).
- `apps/server/src/services/conversationService.ts` — create / add member / remove member key rewrap.
- `apps/server/src/realtime/socket.ts` — real-time delivery (ciphertext-only payloads).
- `apps/web/src/state/crypto.tsx` — browser-side device enrollment + unlock + decrypt.

### Questions to answer explicitly
- Are our XChaCha20-Poly1305 nonces always fresh?
- Are our `secretbox` nonces always fresh?
- Does the emergency-access path have any side channel that weakens the "ciphertext-only at server" claim?
- Does the device enrollment correctly ensure the server never sees a raw private key?
- Are there timing or oracle side-channels in `/auth/login` / `/install/install`?
- Are bridged messages (email/SMS) correctly tagged and never misrepresented as E2E in the UI?
- Does `rotation_version` tracking actually prevent a removed member from reading new messages?

### Threat-model scenarios to exercise
1. Departing staff: revoke device → post new message → removed device cannot unwrap latest `conversation_keys`.
2. Lost recovery phrase: attempt `/admin/export` → must fail for external conversations.
3. Firm subpoena: managing partner enters phrase → can decrypt an external conversation for export.
4. Admin-with-DB-access-only: has ciphertext, wrapped keys, but no passwords → cannot read.
5. Active MITM on a staff login: fails because session cookie is HttpOnly + same-site; socket uses session cookie.

## Out of scope
- Physical security of the appliance.
- Staff OS hardening.
- Email/SMS provider internals (Postmark / Twilio / TextLink) — only the bridge wiring at our edge.
- Secrets management of `.env` (we assume the operator runs a basic secret store).

## Deliverables expected from reviewer
1. Written report (Markdown or PDF).
2. Severity ratings (critical / high / medium / low / informational) with CVSS-ish justification.
3. Remediation suggestions referenced to file:line.
4. Go / no-go recommendation for Phase 17 rollout.

## How to run locally

```bash
yarn install
yarn compose:up
yarn db:migrate && yarn db:seed
yarn test                               # runs every workspace's test suite
yarn workspace @vibe-connect/crypto bench   # prints per-message crypto latency
yarn server:dev                         # http://localhost:4000
yarn web:dev                            # http://localhost:5173
```

## What we already believe to be weak

Listed up front so the reviewer can focus elsewhere:
- Forward secrecy is not provided; conversation keys persist for their rotation window.
- We do not sign messages; recipient authenticates via "only members have the wrapped key".
- `crypto_secretbox_easy` for private-key wrapping; we'd accept a recommendation to standardize on XChaCha20-Poly1305 everywhere.

## Timeline

- Week 1: read, test, report.
- Week 2: we fix every critical/high finding; reviewer re-tests.
- Sign-off document placed at `docs/SECURITY_REVIEW.md` referencing the report.
