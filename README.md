# Vibe Connect

Secure, end-to-end-encrypted staff and client messaging for professional services firms.
Part of the Vibe product family alongside Vibe TB and Vibe MyBooks.

## What's here

- `apps/server` — Node 24 + Express + Knex + Postgres 16 + Socket.io
- `apps/web` — Staff app (Vite + React 18 + TypeScript + Tailwind)
- `apps/portal` — Client portal (Vite + React 18 + TypeScript + Tailwind)
- `apps/desktop` — Tauri 2.x wrapper around the staff web bundle
- `packages/crypto` — libsodium-backed E2EE primitives (shared by server + browser)
- `packages/shared-types` — TypeScript types shared across server and clients
- `infra/docker` — Appliance packaging (Dockerfile, compose, Nginx samples)
- `docs/` — Operations runbooks, threat model, signing procedures

## Stack

See `vibe-connect-build-plan.md` for the full plan. Quick summary:

- Node 24, TypeScript strict, yarn workspaces
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

## Distribution

Vibe Connect ships as two GHCR images that the `vibe-installer` repo pulls
at install time. Single source of truth for the cross-product distribution
scheme is `vibe-distribution-plan.md`.

**Images** (multi-arch: `linux/amd64`, `linux/arm64`):

- `ghcr.io/kisaesdevlab/vibe-connect-server:<version>` — Express API +
  bundled SPA assets, runs as the `vibe` user, exposes :4000. (Pre-v0.1.1
  this image was published as `vibe-connect-app`.)
- `ghcr.io/kisaesdevlab/vibe-connect-client:<version>` — nginx 1.27 with
  the staff and portal SPAs baked in, plus an envsubst-templated
  `nginx.conf` so the same image works in both single-app and multi-app
  modes. Listens on :80, :443, :8443. (Pre-v0.1.1 this image was
  published as `vibe-connect-nginx`.)

Tag conventions: `:1.4.2` (immutable), `:1.4` (rolling minor), `:1`
(rolling major), `:latest`. Operators pin to `:1.4` in production.

**Mode-switching env contract** (defaults are single-app):

| Variable | Single-app | Multi-app |
|---|---|---|
| `BASE_PATH` | `/` | `/connect` |
| `SESSION_COOKIE_PATH` | `/` | `/connect` |
| `TLS_MODE` | `internal` (in-app ACME) | `external` (Caddy / CF Tunnel) |
| `APP_PUBLISH_PORT` | `4000` | unset (`!reset []`) |
| `POSTGRES_PUBLISH_PORT` | `5435` | `5435` |
| `NGINX_PUBLISH_PORT_*` | `80` / `443` / `8443` | unset |

**Volume host paths** (created by the installer):

- `/var/lib/vibe/connect/postgres-data/` — Postgres 16 data dir
- `/var/lib/vibe/connect/uploads/` — encrypted attachment ciphertext
- `/var/lib/vibe/connect/tls/` — certs the in-app ACME ticker drops here
  (read-only mounted into nginx)

The app container runs as a fixed `vibe` user at uid/gid `10001:10001`.
The installer must `chown 10001:10001` on each of those host directories
before first start; without that the in-container `vibe` user can't write
into the bind-mount and the appliance fails health checks. (`postgres-data`
is owned by Postgres's own internal uid 70 — that one is the postgres
image's responsibility, not the operator's.)

**Secrets** (operator-rendered files, mode `0600`, owned by `vibe`):

- `/etc/vibe/connect/.env` — env contract (above) plus provider creds
- `/etc/vibe/connect/postgres_password` — Postgres password (mounted as a
  Docker secret, never in env vars)

**Health endpoints**:

- `GET /ping` — pure liveness, no DB touch. 200 `{ok:true}`. Use for
  HAProxy / Caddy fast probes that must succeed when the DB is briefly
  unavailable.
- `GET /health` — readiness: probes the DB with a 1.5s ceiling and
  reports whether the appliance has been through `/install`. 200
  `{ok:true,service,installed}` when healthy; 503 with structured
  `{code: 'db_unreachable'|'schema_unmigrated'}` otherwise.

**Migrations** run on app boot by default. The appliance overlay sets
`MIGRATIONS_AUTO=false` so the bootstrap can serialize migrations
across Vibe apps that share one Postgres (running them in parallel
from each container's entrypoint races on `knex_migrations` and
surfaces as "Migration directory is corrupt"). When auto-run is
enabled, Knex's advisory-lock-backed migrate tolerates concurrent
starts.

**Backup criticality** (appliance-only, `BACKUP_REQUIRED=true`): an
external backup runner (Duplicati on the appliance, a cron job on
standalone) POSTs to `/admin/backup-heartbeat` after each successful
capture. The server warns after `BACKUP_WARN_DAYS` of silence and
refuses new vault uploads after `BACKUP_BLOCK_DAYS`. The admin
console reads `/admin/key-status` for the firm-key fingerprint and
days-since-last-backup. See `docs/ops/PERSISTENCE.md` for the
operator footguns and `.appliance/manifest.json` for the env
contract.

**Compose files** the installer cares about:

- `infra/docker/docker-compose.yml` — dev/single-app, builds from source
- `infra/docker/docker-compose.grouped.yml` — multi-app overlay (joins
  `vibe_ingress` external network, clears host ports)
- `infra/docker/docker-compose.prod.yml` — installer copies this verbatim;
  references GHCR images, host bind-mounts, Docker secrets

### Releasing

Tag and push:

```bash
git tag v1.4.2
git push --tags
```

`.github/workflows/release.yml` builds + signs both images, pushes to GHCR
under all four tag forms, and attaches Cosign signatures + SBOMs.
Operators verify with:

```bash
cosign verify ghcr.io/kisaesdevlab/vibe-connect-server:1.4.2 \
  --certificate-identity-regexp 'github.com/KisaesDevLab/vibe-connect' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Documentation

- `CLAUDE.md` — project conventions, grep anchors, crypto rules for Claude Code
- `docs/THREAT_MODEL.md` — threat model (Phase 16 handoff)
- `docs/SECURITY_REVIEW_SCOPE.md` — crypto-review scope (Phase 16 handoff)
- `docs/ops/DESKTOP.md` — Tauri thin client, SmartScreen workaround, updater key rotation
- `docs/ops/PERSISTENCE.md` — what survives `docker compose pull`, operator footguns
- `docs/ops/UPDATE_SIGNING.md` — Tauri updater signing-key procedure (legacy; superseded by DESKTOP.md)
- `docs/ops/ROLLOUT.md` — Kisaes internal rollout runbook
- `docs/ops/BACKUP_RECOVERY.md` — backup + recovery procedure
- `docs/ops/EMAIL_DNS.md` — SPF / DKIM / DMARC setup for bridge domain
- `docs/ops/SMS_PROVIDERS.md` — TextLink + Twilio setup

## License

Elastic License 2.0 (ELv2). See [LICENSE](LICENSE) for the full text.
