# Claude Code Kickoff — Vibe Connect Phase 28 (File Transfer / Intake)

You are continuing work on **Vibe Connect**, a self-hosted Docker appliance for CPA firms in the KisaesDevLab / Vibe product family. You will execute Phase 28, an addendum that adds an anonymous-friendly file intake feature called **Vibe File Transfer**.

This kickoff is **stack-grounded** — every primitive named below exists in this repo. If you find one that doesn't, stop and surface it, don't substitute a generic equivalent.

## Inputs you have

- `docs/PHASE_28_ADDENDUM.md` — the full phased build plan with 17 sub-phases, rewritten against Connect's real stack. This is the source of truth for what to build.
- `docs/ADR-028-server-side-encryption-rationale.md` — explains why intake uses server-side encryption with a firm-held key (`CONNECT_INTAKE_ENCRYPTION_KEY`) instead of E2EE. Do not re-litigate this. If a decision in the build plan seems to contradict the ADR, the ADR wins and you should flag the contradiction in `docs/QUESTIONS.md`.
- `docs/QUESTIONS.md` — decisions log. All twelve previously open questions are resolved and implemented in v1. The file is documentation of what was decided and where, not an open backlog.

## Inputs you should consult (these are real paths)

- `CLAUDE.md` at the repo root — stack pins, crypto invariants, the Phase 28 carve-out paragraph, the "do not inline crypto" rule.
- `apps/server/src/db/migrations/` — Knex migration style. Mirror the most recent files (`20260501000001_backup_status.js` is the most recent one and shows the ALTER-firm_settings pattern).
- `apps/server/src/repositories/` — repo style. `repositories/vaults.ts` for row-type interface conventions; `repositories/audit.ts` for the audit-log helper (`auditRepo.write({ actorUserId, action, targetType, targetId, details, ipAddress })`); `repositories/conversations.ts` for transaction-injection style.
- `apps/server/src/services/kekSeal.ts` — the HKDF-SHA256(SESSION_SECRET, salt, info) → secretbox sealing pattern Connect uses for at-rest secrets. **Intake does NOT use this** — intake has its own root key (`CONNECT_INTAKE_ENCRYPTION_KEY`) per ADR-028. But read `kekSeal.ts` to learn the pattern your new `services/intakeCrypto.ts` should mirror structurally (one-place primitive, never inlined elsewhere).
- `apps/server/src/services/tusServer.ts` — Phase 26 in-tree tus 1.0.0 server (no `@tus/server` dep). Phase 28.5 extracts the protocol into a shared `services/tusProtocol.ts` and mounts a second instance for intake; vault keeps its existing wrapper.
- `apps/server/src/services/clamav.ts` — wire-protocol INSTREAM client. The container is added in Phase 28.0 (see below); the code is ready.
- `apps/server/src/services/scheduledMessages.ts` — exemplar in-process ticker with `UPDATE ... RETURNING` row-claim. Phase 28's PDF conversion, notification, auto-purge, and key-rotation workers all follow this pattern.
- `apps/server/src/index.ts:45-61` (ticker start) and `:127-212` (graceful shutdown) — where new intake tickers register.
- `apps/server/src/app.ts` — route mounting. Public routes (e.g., `/portal/*`) mount before auth middleware; staff routes mount after. Phase 28 adds `/api/public/intake/*` to the public section.
- `apps/server/src/bridges/email/index.ts` and `apps/server/src/bridges/sms/index.ts` — email + SMS provider interfaces. Intake notifications reuse these via `getEmailProvider()` / `getSmsProvider()`.
- `apps/server/src/services/attachmentStorage.ts` — local-or-S3 driver interface for at-rest ciphertext. Intake stores encrypted files via this; no new storage code.
- `infra/docker/nginx.conf.template` — single-app ingress. Phase 28.3 adds `/intake`, `/intake/t/`, `/api/public/intake/` to the public-route regex and adds a scoped CSP `add_header` for the `/intake` location.
- `infra/docker/docker-compose.yml` — Phase 28.0 adds a `clamav` service here.
- `apps/portal/src/lib/vaultClient.ts` — tus client logic. Copy the `tusUploadCiphertext()` shape into `apps/intake/src/lib/intakeUploadClient.ts` adapted for anonymous upload tokens.

## Execution rules

1. **Phase 28.0 first.** The kickoff's original "begin with 28.1" assumed a pre-existing ClamAV sidecar. There isn't one. Phase 28.0 adds the `clamav/clamav-debian:stable` service to `docker-compose.yml`, sets `CLAMD_HOST=clamav` / `CLAMD_PORT=3310` defaults in `.env.example`, and verifies `services/clamav.ts:scanBuffer` returns `status='infected'` for the EICAR string. Only then start 28.1.
2. **One sub-phase at a time, in order.** Do not begin 28.N+1 until 28.N's acceptance criteria are met.
3. **Every checklist item gets a check.** Mark items `[x]` as you complete them by editing `docs/PHASE_28_ADDENDUM.md` in place. If you skip an item, note why in the same edit.
4. **Acceptance criteria are non-negotiable.** Run the relevant tests, exercise the relevant paths, and only then advance.
5. **No new architectural decisions.** If you hit something genuinely ambiguous that is not covered by the build plan, the ADR, or existing Connect conventions, append to `docs/QUESTIONS.md` with a sensible default, implement that default, and continue. Do not pause for synchronous input.
6. **No new dependencies without justification.** The plan calls for `jscanify`, `pdf-lib`, and `sharp`. The original kickoff also named `@tus/server` — **do not install it**; reuse `apps/server/src/services/tusServer.ts` via the protocol extraction in 28.5. Anything beyond that list gets a one-line justification in the commit message.
7. **Tests live next to code.** Vitest unit tests (`*.test.ts`, `*.test.tsx`) as you go. Playwright E2E in 28.17. Do not defer unit tests to the end.
8. **Commit per sub-phase.** Conventional commits: `feat(intake): 28.3 public intake landing page`. Include the sub-phase number for traceability.
9. **Audit log everything.** Every state-changing API in 28.4–28.16 must call `auditRepo.write({ action: 'intake.<event>', ... })` from `apps/server/src/repositories/audit.ts` BEFORE the response is sent. Phase 28 reuses the existing `audit_log` table — there is no per-feature audit table. 28.17 includes an explicit verification pass — do not wait until then to add the events.

## Stack reminders (verified against this repo)

- **Node 24**, TypeScript strict (all strict flags in `tsconfig.base.json`).
- **yarn 1.22 workspaces** (`package.json` "workspaces": `["apps/*", "packages/*"]`). Not pnpm. Scripts: `yarn server:dev`, `yarn workspace @vibe-connect/intake dev`, `yarn db:migrate`, `yarn db:rollback`.
- **Postgres 16**, accessed via **Knex**. Not Drizzle. No `src/db/schema/*.ts` Drizzle files anywhere.
- **No Redis. No BullMQ.** Background work is in-process `setInterval` tickers with `UPDATE ... RETURNING` row-claim for atomicity. Seven exist today (`scheduledMessages`, `destructMessages`, `autoNudge`, `retention`, `vaultRetention`, `tlsAcme`, `backupWatcher`); Phase 28 adds five more.
- **nginx** is the single-app ingress (`infra/docker/nginx.conf.template`). **Caddy** is only present in multi-app mode as an external `vibe_ingress` network reached via `docker-compose.grouped.yml`. The original kickoff's "Caddy is the sole ingress" line was wrong.
- **No CLI binary exists.** Admin operations are HTTP routes under `/admin/*`. The original kickoff's `vibe-connect intake rotate-key` becomes `POST /admin/intake/rotate-key` per Phase 28.16.
- **No Prometheus exporter.** Metrics ship as structured `logger.info('intake.<metric_name>', { ... })` events until a dedicated phase wires `prom-client`. The original kickoff's "/metrics" claim was wrong.
- **No i18n framework.** All UI strings are hardcoded English. The `intake.*` namespace is reserved in the build plan for a future i18n phase; for v1, hardcode in English to match the rest of `apps/web`.
- **tus 1.0.0** for resumable uploads, but **in-tree**, not `@tus/server`. See `apps/server/src/services/tusServer.ts` header comment for the rationale.
- **React 18 + Vite + Tailwind CSS** for `apps/web` (staff), `apps/portal` (client portal), and new `apps/intake` (Phase 28 public bundle).
- **Tauri 2.x** thin client for desktop (`apps/desktop`). Phase 28 does not touch desktop.
- **libsodium via `libsodium-wrappers`**, same API in Node and browser. **All crypto goes through `packages/crypto`** — do not inline.
- **Socket.io** for realtime; **Postgres LISTEN/NOTIFY** for fanout. Phase 28.12 in-app notice uses `apps/server/src/realtime/pgFanout.ts` with a new `intake.session.received` event type.
- **Postmark / SMTP** for email; **TextLink / Twilio** for SMS — both behind provider interfaces in `apps/server/src/bridges/`.

## Encryption rules

- Use `apps/server/src/services/intakeCrypto.ts` (created in 28.1) for every encrypt/decrypt operation. Do not call libsodium primitives or `packages/crypto` exports directly from intake feature code.
- The root key is the env var `CONNECT_INTAKE_ENCRYPTION_KEY` (32 bytes base64). It is independent of `SESSION_SECRET` per ADR-028. The server boots with a clear error if the env var is missing in `NODE_ENV=production` with intake enabled.
- Plaintext PII (client name, email, phone) must never be written to disk, logged, or sent in audit event payloads. Hash these for audit purposes via `intakeCrypto.hashForAudit()`.
- Decryption-on-view in the staff UI (28.11) is itself an audited event (`intake.session.decrypted_on_view`).
- Temp files during 28.9 PDF conversion: write to `/tmp/intake-conversion-${jobId}/` and unlink in a `finally` block. Do not assume the OS will clean up.
- Deterministic search hashes (`client_email_hash`, etc.) use a *separate* HKDF derivation from `SESSION_SECRET` with salt `vibe-connect/intake-search/v1`, **not** the intake content key. This decouples staff-search functionality from intake-key rotation.

## What "done" looks like for Phase 28

- All 17 sub-phases (28.0 through 28.17) have every checklist item checked or explicitly noted-and-justified.
- Playwright E2E suite green in CI (including retention, key rotation smoke, client linking).
- Load test in 28.17 passes documented SLOs.
- `docs/ops/INTAKE.md` and `docs/ops/INTAKE_FIRM_ADMIN.md` written and linked from README.
- CHANGELOG updated, release tagged.
- `docs/QUESTIONS.md` reflects any new decisions made during execution that weren't in the original plan.
- `apps/intake/` builds, lints, type-checks, and ships its own `manifest.webmanifest`.
- ClamAV sidecar present in `docker-compose.yml`; `yarn compose:up` boots cleanly with it.

## Communication

- After each sub-phase, post a short status summary: what was done, what tests pass, any items deferred to `docs/QUESTIONS.md`, what's next. No need to wait for a reply — proceed to the next sub-phase.
- If something is genuinely blocked (e.g., a required existing Connect helper does not exist and creating it is out of scope for intake), stop and surface it. Otherwise keep moving.

## Start command

Begin with **sub-phase 28.0** (ClamAV sidecar + env defaults), verify EICAR detection works, then move to 28.1. Read the existing Knex migrations and `repositories/vaults.ts` first, then write the 28.1 migration.

`Bash(*)` permissions are granted. Use them.
