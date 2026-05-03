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
- Symmetric: XChaCha20-Poly1305. Asymmetric: X25519.
- KDFs by purpose:
  - Device passphrase → device private key wrap: Argon2id (memory-hard;
    passphrase entropy is bounded by what a human types).
  - Recovery phrase → firm-key wrap: BLAKE2b-256(entropy, salt). The 24-word
    BIP-39 phrase already carries 256 bits of real entropy, so memory hardness
    adds no attacker cost; the phrase itself IS the security boundary.
  - SESSION_SECRET → server-side KEKs (sealed provider creds, avatar
    ciphertext, ACME account key, unsubscribe tokens): HKDF-SHA256.
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
- **Phase 24 deliberate exception (Client Requests).** `request_lists.title` /
  `description` and `request_items.status` / `due_date` are stored cleartext so the
  server can render the portal Requests tab pre-unwrap, compute progress, and template
  nudge bodies. **Item titles, descriptions, and revision notes** stay E2EE under the
  conversation's content key (same envelope as messages). Linkage from a message to
  an item lives on the existing `messages.ciphertext_meta` JSONB blob — reserved keys
  are `requestItemId`, `requestListId`, `systemEventType`, `revisionNoteCiphertext`.
  See `docs/ops/REQUESTS.md` for the full crypto split + threat-model trade-off.
- **Phase 26 — Client Vault.** Per-client durable file storage with two zones
  (`shared`, `staff_only`). Each `client_vaults` row has zone keys in `vault_keys`
  (mirrors `conversation_keys.wrapped_keys` shape; same recipientId scheme). File
  bytes and filenames are E2EE under a per-file key wrapped to the zone key;
  `mime_type`, `size_bytes`, `uploaded_at`, and folder structure remain plaintext
  metadata. Hard zone-separation invariant: `staff_only` wrapped keys are never
  emitted to a `client:*` recipient — enforced at `vaultKeysRepo.byVaultIdForSession`
  (load-bearing) plus belt-and-suspenders 404 on portal vault routes for any
  staff-only file id. `messages.ciphertext_meta` reserved keys for vault system
  events: `vaultFileId`, `vaultFolderId`, `vaultZone` (`'shared'` only — staff_only
  events never appear in client-visible threads), and `systemEventType` extended with
  `'vault_file_uploaded'`, `'vault_file_deleted'`. Resumable uploads use tus 1.0.0
  (vault only — message attachments stay multipart). See `docs/ops/VAULT.md` (admin)
  and `docs/ops/VAULT_CLIENT.md` (client).

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
- `apps/desktop` — Tauri 2.x **thin client**. Ships a tiny onboarding HTML
  (`apps/desktop/onboarding/`, built to `apps/desktop/dist/`) that asks the
  user for their firm's appliance URL on first run, then navigates the
  webview directly to `https://<appliance>/` for every subsequent launch.
  The Rust shell exposes five IPC commands
  (`get/set/clear_appliance_url`, `navigate_to_appliance`,
  `get_desktop_version`); the URL is persisted via `tauri-plugin-store`
  in `%APPDATA%/app.vibeconnect.desktop/settings.json` (Windows). See
  `docs/ops/DESKTOP.md`. The web bundle (`apps/web`) is served by the
  appliance, not the desktop — so any appliance update reaches every
  desktop on next reload without a redeploy.
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
- `Phase 24` / `request.*` audit actions — Client Requests & Document Collection.
  See `docs/ops/REQUESTS.md` (admin) and `docs/ops/REQUESTS_CLIENT.md` (client).
- `Phase 26` / `vault.*` audit actions — Client Vault. See `docs/ops/VAULT.md`
  (admin) and `docs/ops/VAULT_CLIENT.md` (client).

## Stack pins

- Node 24, TypeScript strict (all strict flags in `tsconfig.base.json`).
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

### Distribution mode (Vibe family integration)

The same image runs in **single-app** mode (one product per host, direct
ports) and **multi-app** mode (shared Caddy ingress at
`https://<host>/connect/`). Mode is a runtime choice — never bake it into a
build. See `vibe-distribution-plan.md` for the cross-product shape and
`C:\Users\kwkcp\.claude\plans\polymorphic-brewing-corbato.md` for the
Vibe-Connect-specific implementation phases.

Mode-switching env knobs (defaults are single-app):

- `BASE_PATH` — `/` or `/connect`. Read by the server (`env.basePath`) and
  emitted to the SPA via `/__vibe-boot.js` so React Router gets the right
  basename and `apps/{web,portal}/src/lib/boot.ts:url()` prepends it to
  every fetch.
- `SESSION_COOKIE_PATH` — `/` or `/connect`. Wired into both `req.session`
  cookie (in `app.ts`) and the portal's manual `res.cookie(SESSION_COOKIE,
  …)` calls in `routes/portal.ts`. Sibling Vibe apps on the same host can't
  read each other's sessions.
- `TLS_MODE` — `internal` (Phase-23 in-app ACME ticker is on; admin TLS
  endpoints accept writes) or `external` (Caddy / Cloudflare Tunnel
  terminates TLS upstream; ticker is skipped at startup; admin write paths
  return 409 `tls_managed_externally`). The HTTP-01 responder route stays
  mounted in both modes.
- `APP_PUBLISH_PORT`, `POSTGRES_PUBLISH_PORT`, `NGINX_PUBLISH_PORT_*` —
  Compose-only knobs the single-app `docker-compose.yml` honors. The
  `docker-compose.grouped.yml` overlay clears them with `!reset []` so the
  containers reach the host only via the `vibe_ingress` external network.
- `BUILD_VERSION` — surfaced to the SPA via the bootstrap script. Set by
  the release pipeline; defaults to `'dev'`.

The SPA bundles build with Vite `base: './'` and use a
`<base href="__BASE_HREF__/">` placeholder that nginx's `sub_filter`
substitutes at request time. One bundle, two modes, no rebuild.

## Things to ignore / defer

- OIDC — present but off by default. Activated by setting `OIDC_ISSUER_URL`
  + the related env vars. The login page hides the "Sign in with SSO"
  button when issuer discovery fails or the env is blank.
- Shamir secret sharing of recovery phrase — future phase.
- Dark theme — deferred.
- S3 attachment driver — interface shaped for it, local driver is default.
- Redis — only introduced if the TextLink bridge poller demands it.
