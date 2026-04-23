# Vibe Connect

Secure, end-to-end-encrypted staff and client messaging for professional services firms.
Part of the Vibe product family alongside Vibe TB and Vibe MyBooks.

## What's here

- `apps/server` — Node 20 + Express + Knex + Postgres 16 + Socket.io
- `apps/web` — Staff app (Vite + React 18 + TypeScript + Tailwind)
- `apps/portal` — Client portal (Vite + React 18 + TypeScript + Tailwind)
- `apps/desktop` — Tauri 2.x wrapper around the staff web bundle
- `packages/crypto` — libsodium-backed E2EE primitives (shared by server + browser)
- `packages/shared-types` — TypeScript types shared across server and clients
- `infra/docker` — Appliance packaging (Dockerfile, compose, Nginx samples)
- `docs/` — Operations runbooks, threat model, signing procedures

## Stack

See `vibe-connect-build-plan.md` for the full plan. Quick summary:

- Node 20, TypeScript strict, yarn workspaces
- PostgreSQL 16 via Docker compose
- libsodium (`libsodium-wrappers`) for all crypto (XChaCha20-Poly1305 + X25519 + Argon2id)
- Socket.io + Postgres `LISTEN/NOTIFY` for real-time
- FlexSearch client-side search over decrypted messages
- Postmark (email) and TextLink/Twilio (SMS) behind provider interfaces with dev mocks

## First-time setup

```bash
yarn install
cp .env.example .env                              # edit as needed
yarn compose:up                                   # starts Postgres
yarn db:migrate
yarn db:seed
yarn server:dev                                   # http://localhost:4000
yarn web:dev                                      # http://localhost:5173
yarn portal:dev                                   # http://localhost:5174
```

## Scripts

- `yarn typecheck` — strict TypeScript across every workspace
- `yarn lint` — ESLint across the repo
- `yarn format` — Prettier write
- `yarn test` — run all workspace test suites
- `yarn db:migrate` / `db:rollback` / `db:seed` / `db:reset` — database lifecycle
- `yarn compose:up` / `compose:down` / `compose:logs` — appliance compose controls

## Documentation

- `CLAUDE.md` — project conventions, grep anchors, crypto rules for Claude Code
- `docs/THREAT_MODEL.md` — threat model (Phase 16 handoff)
- `docs/SECURITY_REVIEW_SCOPE.md` — crypto-review scope (Phase 16 handoff)
- `docs/ops/UPDATE_SIGNING.md` — Tauri updater signing-key procedure
- `docs/ops/ROLLOUT.md` — Kisaes internal rollout runbook
- `docs/ops/BACKUP_RECOVERY.md` — backup + recovery procedure
- `docs/ops/EMAIL_DNS.md` — SPF / DKIM / DMARC setup for bridge domain
- `docs/ops/SMS_PROVIDERS.md` — TextLink + Twilio setup

## License

Proprietary. Internal use.
