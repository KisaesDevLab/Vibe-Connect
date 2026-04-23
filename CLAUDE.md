# Vibe Connect — Project Context for Claude Code

Everything below is load-bearing. Read before you touch code.

## What this product is

Secure staff-first messaging replacing PinkNotes inside CPA firms, extending into encrypted
staff↔client communication via a web portal, email-in/out bridge, and SMS-in/out bridge. Part
of the Vibe product family (Vibe TB, Vibe MyBooks). See `vibe-connect-build-plan.md`.

## Crypto conventions — NEVER violate

- All conversations are end-to-end encrypted with a firm-recoverable key model.
- Server stores **ciphertext only**. Plaintext touches server memory only during the
  email-in / SMS-in bridge handoff (microseconds) and in admin-initiated audit decryption.
- Symmetric: XChaCha20-Poly1305. Asymmetric: X25519. Password KDF: Argon2id.
- Primitives live in `packages/crypto`. **Do not inline nacl/crypto calls elsewhere.**
- Conversation key is wrapped per device (staff) or per session (clients) in
  `conversation_keys.wrapped_keys` JSONB. Membership change → rewrap (simplest) or
  incremental wrap (optimization). Rotation is versioned via `content_key_version`.
- Firm recovery: BIP-39-style 24-word phrase. Displayed once on install, never logged,
  never stored anywhere the server can read. Required for emergency decryption + firm-key
  rotation + (by default) external-conversation exports.
- Bridged messages (`source = 'email-in' | 'sms-in'`) MUST render a visible indicator.
  Never imply end-to-end for bridged-in content.
- Never send message content in push notification payloads, email fallback notifications,
  or SMS outbound notification bodies — metadata + "open the portal/app" only.

## Non-goals — do not build these

- Subject lines, Must-Reply / Confidential flags, structured contact fields
- Rich text beyond bold/italic/newlines + autolinks
- Channels / streams / topics
- Shared calendars, to-dos
- Voice / video, federation, marketplace, omnichannel
- Native mobile apps (PWA only)
- Password-based client accounts (access-code only)

## Directory map & ownership

- `apps/server` — Express + Knex + Socket.io. Single source of truth for API contracts.
- `apps/web` — Staff app. Tauri webview loads this same bundle.
- `apps/portal` — Client portal. **No staff features.** Kept intentionally minimal.
- `apps/desktop` — Tauri 2.x shell. Rust is kept thin; UI is `apps/web`.
- `packages/crypto` — Crypto primitives. Treat as frozen API; changes go through review.
- `packages/shared-types` — Types only, zero runtime code.
- `infra/docker` — Appliance packaging.
- `docs/` — Runbooks + security docs.

## Grep anchors

- `CRYPTO:` — crypto-sensitive code or invariants.
- `BRIDGE:` — email/SMS bridge plaintext-window sites (gateway-in / gateway-out).
- `AUDIT:` — audit-log emitters.
- `STEPUP:` — SSN/EIN step-up gates.
- `TODO(phaseN)` — deferred work keyed to the build plan phase.

## Stack pins

- Node 20, TypeScript strict (all strict flags in `tsconfig.base.json`).
- yarn workspaces (see `package.json workspaces`).
- Postgres 16.
- React 18 + Vite + Tailwind CSS for staff + portal.
- Tauri 2.x for desktop.
- libsodium via `libsodium-wrappers` (same API in Node and browser).
- Socket.io for realtime; Postgres `LISTEN/NOTIFY` for fanout between server instances.
- FlexSearch for client-side search; index persisted in encrypted IndexedDB.
- Postmark (email) / TextLink + Twilio (SMS) behind provider interfaces.

## Coding rules

- Strict TS everywhere. No `any` without a `// eslint-disable-next-line` + reason.
- Prefer small modules over big files. One responsibility per module.
- No database access from route handlers — go through a repository module.
- No crypto outside `packages/crypto`.
- Every new route gets an integration test. Every new crypto primitive gets a test vector.
- Audit-log any privileged action (device revoke, emergency decrypt, admin setting change).
- Never skip hooks, bypass signing, or use `--force` without explicit direction.

## Testing conventions

- Unit: Vitest. Files: `*.test.ts`, `*.test.tsx`.
- Integration (server): Supertest + an ephemeral Postgres schema per run.
- Crypto: deterministic test vectors committed alongside primitives.
- Load (Phase 5): 50 concurrent users, ≤200ms realtime delivery.
- "Aggressive" phase-exit test = typecheck + lint + all test suites + corrupt-input fuzz
  where relevant + smoke boot of docker-compose when infra touched.

## Environment

- `.env.example` carries every env var with a safe default using mock providers.
- Real provider credentials go in `.env` (gitignored).
- Dev mock providers write outbound messages to `.outbox/` for inspection.

## Things to ignore / defer

- OIDC — deferred.
- Shamir secret sharing of recovery phrase — future phase.
- Dark theme — deferred.
- S3 attachment driver — interface shaped for it, local driver is default.
- Redis — only introduced if the TextLink bridge poller demands it.
