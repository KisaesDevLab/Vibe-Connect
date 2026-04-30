# Vibe Product Family — Distribution Plan

## Context & principles

Four products (Vibe MyBooks, Vibe Connect, Vibe TB, Vibe Payroll Time) need to ship as self-hosted Docker appliances that a CPA firm operator can install on:

- a **single-tenant appliance** (NucBox M6 running Ubuntu Server 24.04 LTS), or
- a **DigitalOcean droplet** (Ubuntu 24.04, 4 vCPU / 8 GB GP Premium Intel as the floor), or
- in development, a **Windows host** running Docker Desktop.

Each app must be installable in two modes without code changes:

- **Single-app mode** — one product per host, no shared ingress, app publishes its own ports. Simplest for a firm running just one Vibe product.
- **Multi-app mode** — two or more products on the same host behind a shared Caddy ingress at `https://<host>/<app>`. Cookies, ports, and DBs stay isolated; only the front door is shared.

Mode is a runtime choice (env vars + Compose overrides), not a build-time choice. The same GHCR image runs in both. Defaults match single-app behavior so an operator who follows the simplest path gets the simplest setup.

Three architectural principles carry over from prior work:

1. **Customer-owned Cloudflare resources.** When a firm uses Cloudflare Tunnel, the CF account is theirs, not Kisaes'. The installer prompts for the firm's tunnel token; it never embeds Kisaes credentials.
2. **OCR/LLM is local Tier 1.** GLM-OCR (and any future local model) runs on the same host or an adjacent appliance. Cloud AI is optional Tier 2.
3. **Per-app data isolation.** Each app keeps its own Postgres, Redis, and volumes. The shared ingress never touches DBs.

Licensing stays as established: BSL 1.1 with 4-year Apache 2.0 conversion for the Vibe products; PolyForm Internal Use 1.0.0 for the MyBooks client portal.

---

## Distribution architecture

### Image publishing (GHCR)

Each app publishes versioned multi-arch images to GitHub Container Registry under `KisaesDevLab`:

```
ghcr.io/kisaesdevlab/vibe-mybooks-api:1.4.2
ghcr.io/kisaesdevlab/vibe-mybooks-web:1.4.2
ghcr.io/kisaesdevlab/vibe-mybooks-worker:1.4.2

ghcr.io/kisaesdevlab/vibe-connect:1.2.0          # single-image; SPA + API combined
ghcr.io/kisaesdevlab/vibe-tb-api:0.9.5
ghcr.io/kisaesdevlab/vibe-tb-web:0.9.5
ghcr.io/kisaesdevlab/vibe-payroll-api:0.3.0
ghcr.io/kisaesdevlab/vibe-payroll-web:0.3.0
```

Tag conventions: `:1.4.2` (immutable release), `:1.4` (rolling minor), `:1` (rolling major), `:latest` (rolling). Operators pin to a specific minor in production. CI builds on tagged commits via GitHub Actions; SBOMs and Cosign signatures attached to release tags.

### Repo split

| Repo | Owns | Audience |
|---|---|---|
| `KisaesDevLab/vibe-mybooks` (etc.) | Source code, Dockerfiles, dev Compose, grouped override | Developers (Kurt + future contributors) |
| `KisaesDevLab/vibe-installer` (new) | Host bootstrap script, `vibe` CLI, prod Compose for each app, ingress stack | End-user CPA firms / IT operators |

The installer repo is the only thing a customer ever clones. It pulls pre-built GHCR images; it never builds locally.

### Compose file convention (per app repo)

Every app repo ships three Compose files:

| File | Purpose | Used by |
|---|---|---|
| `docker-compose.yml` | Dev defaults: builds from source, host ports published, single-app env values | Developers running `docker compose up` |
| `docker-compose.grouped.yml` | Dev grouped overlay: clears host ports, joins `vibe_ingress`, sets multi-app env values | Developers testing multi-app locally |
| `docker-compose.prod.yml` | Prod definition: pulls from GHCR by tag, no `build:` directives, prod-safe defaults | The installer repo, via `extends:` or include |

The installer repo references `docker-compose.prod.yml` from each app repo (or vendors a copy at install time) and layers its own overrides for ingress, secrets, and host paths.

---

## Per-app distribution plan

### Vibe MyBooks

**Images:** `vibe-mybooks-api`, `vibe-mybooks-web`, `vibe-mybooks-worker` (BullMQ).

**Compose services:** `api`, `web`, `worker`, `postgres`, `redis`. Optional profiles: `cloudflared` (existing), `glm-ocr` (Ollama sidecar for local OCR).

**Mode-switching env knobs:**

| Variable | Single-app default | Multi-app value |
|---|---|---|
| `VITE_BASE_PATH` | `/` | `/mybooks/` |
| `COOKIE_PATH` | `/` | `/mybooks` |
| `COOKIE_SECURE` | `false` | `true` |
| `CORS_ORIGIN` | `http://localhost:5173` | `https://<host>` |
| `PUBLIC_URL` | `http://localhost:5173` | `https://<host>/mybooks` |
| `WEBAUTHN_RP_ID` | `localhost` | `<host>` (e.g. `vibe.local`) |
| `WEB_PUBLISH_PORT` | `5173` | unset (no host port) |
| `API_PUBLISH_PORT` | `3001` | unset |
| `POSTGRES_PUBLISH_PORT` | `5434` | `5434` (kept; allows direct psql access) |

**Persistent volumes (host paths under `/var/lib/vibe/mybooks/`):**
- `postgres-data/` — Postgres 16 data dir
- `redis-data/` — Redis AOF
- `uploads/` — receipts, statements
- `backups/` — Duplicati target (per the existing four-level backup pattern)

**Secrets generated at install time** (written to `/etc/vibe/mybooks/.env`, mode 0600):
`POSTGRES_PASSWORD`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `SESSION_SECRET`, `LICENSE_PUBLIC_KEY` (fetched from `licensing.kisaes.com`).

**Cloudflare Tunnel:** `cloudflared` profile activated by setting `CLOUDFLARE_TUNNEL_TOKEN` in env. Token is the customer's, not Kisaes'.

**Health check:** `GET /api/v1/health` returns `{status:"ok", db:"ok", redis:"ok", queue:"ok"}`.

**Migration on upgrade:** `worker` container runs `drizzle-kit migrate` on boot before BullMQ starts; `api` waits on `worker` healthy.

**App-specific notes:** Plaid, Stripe Connect, GLM-OCR endpoints all configurable via env. The license enforcement check (RSA-signed JWT) runs at API boot — installer must register the host with `licensing.kisaes.com` and place the activation token in env.

### Vibe Connect

**Image:** `vibe-connect` (single image — Express serves both SPA and API).

**Compose services:** `app`, `postgres`. No Redis. The existing `nginx` service is **deleted** in `docker-compose.prod.yml` — Caddy replaces it in multi-app mode, and in single-app mode the app exposes itself directly on a host port.

**Mode-switching env knobs:**

| Variable | Single-app default | Multi-app value |
|---|---|---|
| `BASE_PATH` | `/` | `/connect/` |
| `SITE_URL` | `http://localhost:4000` | `https://<host>/connect` |
| `PORTAL_URL` | `http://localhost:4000/portal` | `https://<host>/connect/portal` |
| `API_URL` | `http://localhost:4000/api` | `https://<host>/connect/api` |
| `SESSION_COOKIE_PATH` | `/` | `/connect` |
| `OIDC_ISSUER_HOST` | `localhost` | `<host>` |
| `APP_PUBLISH_PORT` | `4000` | unset |
| `POSTGRES_PUBLISH_PORT` | `5435` | `5435` |

**Persistent volumes:** `/var/lib/vibe/connect/postgres-data/`, `/var/lib/vibe/connect/uploads/`.

**Health check:** `GET /health` (existing route).

**App-specific notes:** OIDC issuer host check needs to accept the configured host. The existing `infra/docker/nginx.conf` and `tls/` directory stay in the repo for dev fallback but are not referenced by any prod Compose.

### Vibe TB

**Images:** `vibe-tb-api`, `vibe-tb-web`.

**Compose services:** `api`, `web`, `postgres`, `pgadmin` (optional, behind a `tools` profile).

**Mode-switching env knobs:**

| Variable | Single-app default | Multi-app value |
|---|---|---|
| `VITE_BASE_PATH` | `/` | `/tb/` |
| `COOKIE_PATH` | `/` | `/tb` |
| `COOKIE_SECURE` | `false` | `true` |
| `ALLOWED_ORIGIN` | `http://localhost:5173` | `https://<host>` |
| `APP_BASE_URL` | `http://localhost:5173` | `https://<host>/tb` |
| `WEB_PUBLISH_PORT` | `5173` | unset |
| `API_PUBLISH_PORT` | `3001` | unset |
| `POSTGRES_PUBLISH_PORT` | `5436` | `5436` (was hardcoded `5432` — must change) |
| `PGADMIN_PUBLISH_PORT` | `5051` | `5051` (was `5050`) |

**Persistent volumes:** `/var/lib/vibe/tb/postgres-data/`, `/var/lib/vibe/tb/workpapers/`, `/var/lib/vibe/tb/backups/`.

**App-specific notes:** Cloudflare Access stays an option (TB's small staff counts fit free tier). The 1,061-row UltraTax CS crosswalk ships baked into the image — no install-time data load. LLM provider config (Anthropic / Ollama / OpenAI-compatible) is env-driven via the existing capability registry.

### Vibe Payroll Time

**Images:** `vibe-payroll-api`, `vibe-payroll-web`.

**Compose services:** `api` (renamed from `backend`), `web` (renamed from `frontend`), `postgres`, `redis` (for BullMQ if added). The existing project-internal `caddy/Caddyfile` and host-process dev pattern do **not** ship in prod Compose — both backend and frontend are containerized for distribution.

**Mode-switching env knobs:**

| Variable | Single-app default | Multi-app value |
|---|---|---|
| `VITE_BASE_PATH` | `/` | `/payroll/` |
| `VITE_DEV_BACKEND_ORIGIN` | `http://localhost:4000` | `/payroll/api` (relative) |
| `COOKIE_PATH` | `/` | `/payroll` |
| `COOKIE_SECURE` | `false` | `true` |
| `CORS_ORIGIN` | `http://localhost:5180` | `https://<host>` |
| `WEB_PUBLISH_PORT` | `5180` | unset |
| `API_PUBLISH_PORT` | `4000` | unset |
| `POSTGRES_PUBLISH_PORT` | `5437` | `5437` (was default `5432`) |
| `PGADMIN_PUBLISH_PORT` | `5052` | `5052` (was `5050`) |

**Persistent volumes:** `/var/lib/vibe/payroll/postgres-data/`, `/var/lib/vibe/payroll/redis-data/`, `/var/lib/vibe/payroll/exports/`.

**App-specific notes:** Twilio + TextLinkSMS provider abstraction config via env. PIN-kiosk mode flag (`KIOSK_MODE=true`) is host-level, not mode-dependent. PWA manifest `start_url` and `scope` derive from `VITE_BASE_PATH` automatically.

---

## Installer repo: `KisaesDevLab/vibe-installer`

### Layout

```
vibe-installer/
├── README.md
├── install.sh                      # one-shot host bootstrap
├── bin/
│   └── vibe                        # CLI entry point (bash)
├── lib/
│   ├── apps.sh                     # per-app install/upgrade/uninstall
│   ├── ingress.sh                  # Caddy lifecycle
│   ├── mode.sh                     # single-app ↔ multi-app switching
│   ├── secrets.sh                  # generate/rotate secrets
│   └── checks.sh                   # health checks, prereq verification
├── apps/
│   ├── mybooks/
│   │   ├── docker-compose.yml      # references ghcr.io images, prod env
│   │   ├── docker-compose.grouped.yml
│   │   └── env.template
│   ├── connect/
│   ├── tb/
│   └── payroll/
├── ingress/
│   ├── docker-compose.yml          # Caddy
│   ├── Caddyfile.template          # rendered with installed apps' routes
│   └── landing/index.html
└── etc/
    └── vibe.conf.template          # /etc/vibe/vibe.conf — installed apps registry
```

### `install.sh` — one-shot host bootstrap

```bash
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/vibe-installer/main/install.sh | sudo bash
```

What it does, in order:

1. **Verify host:** Ubuntu 24.04 LTS, x86_64, ≥ 8 GB RAM, ≥ 40 GB free in `/var`. Bail with a clear message if not.
2. **Install Docker** (official `get.docker.com` script) if `docker` not present.
3. **Clone the installer repo** to `/opt/vibe-installer/`.
4. **Symlink** `bin/vibe` → `/usr/local/bin/vibe`.
5. **Create directories:** `/var/lib/vibe/`, `/etc/vibe/`, `/var/log/vibe/` with `0750` perms owned by a new `vibe` system user.
6. **Create the `vibe_ingress` Docker network** (idempotent).
7. **Print next steps:** `vibe install <app>` to add an app, `vibe status` to inspect.

Crucially, `install.sh` does *not* install any Vibe app. It only prepares the host. Apps are added one at a time via the CLI.

### `vibe` CLI

The CLI is a bash script that wraps Docker Compose with mode awareness. Commands:

| Command | Effect |
|---|---|
| `vibe install <app>` | Pull images, generate secrets, render env, bring app up. Auto-promotes to multi-app mode if a second app is added. |
| `vibe uninstall <app>` | Stop containers, archive `/var/lib/vibe/<app>/` to `/var/lib/vibe/.archive/<app>-<timestamp>/`, remove from registry. |
| `vibe upgrade <app> [--to <version>]` | Pull new image tag, run migrations, restart. Defaults to latest minor of currently installed major. |
| `vibe status` | Show installed apps, versions, health, current mode. |
| `vibe mode [single\|multi]` | Force a mode switch. With no arg, prints current mode. |
| `vibe logs <app> [service]` | Tail logs. |
| `vibe exec <app> <service> <cmd>` | Run a command in a container (e.g. `vibe exec mybooks api sh`). |
| `vibe backup <app>` | Snapshot the app's volumes via Duplicati (configured separately) or a tar fallback. |
| `vibe doctor` | Run all health checks, report problems. |

### Mode switching logic

Stored in `/etc/vibe/vibe.conf`:

```
mode=single          # or 'multi'
host=vibe.local      # or the customer's chosen FQDN
installed=mybooks    # comma-separated
```

Transitions:

- **0 → 1 app:** mode stays `single`. App's `docker-compose.yml` runs alone, ports published.
- **1 → 2 apps:** `vibe install <second>` detects a second app being added. Prompts: *"Adding a second app requires multi-app mode (shared HTTPS ingress at `https://<host>/`). Continue? [Y/n]"*. On yes:
  1. Tear down the existing app cleanly.
  2. Bring up the Caddy ingress.
  3. Bring both apps up with `-f docker-compose.yml -f docker-compose.grouped.yml`.
  4. Run `caddy trust` on the host.
  5. Update `/etc/vibe/vibe.conf` to `mode=multi`.
  6. Render `Caddyfile.template` with both apps' routes.
- **2 → 1 app (uninstall):** `vibe uninstall` of the second-to-last app prompts: *"Returning to single-app mode. The remaining app will lose its `/<prefix>` URL. Continue? [Y/n]"*. On yes, swap Compose files and tear down ingress.
- **Forced switch via `vibe mode`:** explicit operator override, useful for testing.

### Secret management

Secrets generated on first install per app, stored in `/etc/vibe/<app>/.env` (mode 0600, owned by `vibe`). Rotated via `vibe rotate-secrets <app>` (planned v1.1). Secrets *never* committed; the installer repo ships only `env.template` files with placeholders.

License tokens (Kisaes-issued) entered interactively during install or set via `VIBE_LICENSE_TOKEN_<APP>` env var for unattended installs.

### Update mechanism

Two layers, updated independently:

- **Installer itself:** `vibe self-update` pulls the latest `vibe-installer` repo. Atomic — either fully updates or rolls back.
- **App images:** `vibe upgrade <app>` pulls the new tag, runs migrations, restarts. Compose's healthcheck-based restart means brief downtime per app, not the full host.

A weekly systemd timer (`vibe-check-updates.timer`) checks GHCR for new minor versions and emails the operator (config'd address). It does not auto-apply.

### Uninstall (full)

`vibe uninstall --all` tears down every app and the ingress, archives all data to `/var/lib/vibe/.archive/`, and prompts before removing Docker, the `vibe` user, or `/var/lib/vibe`.

---

## Build / phasing plan

Eight phases, each landing as its own PR with verification before merge.

| Phase | Scope | Acceptance |
|---|---|---|
| 1 | Per-app: env-driven config refactor + `docker-compose.grouped.yml` overlay (4 PRs, one per app) | Both `docker compose up` and `docker compose -f ... -f grouped.yml up` pass health checks |
| 2 | Per-app: `docker-compose.prod.yml` referencing GHCR images + GitHub Actions release pipeline (4 PRs) | Tagged commit in each app repo publishes signed multi-arch images to GHCR |
| 3 | New repo: `vibe-installer` skeleton — `install.sh` + `bin/vibe` stub + `apps/mybooks/` only | `install.sh` on a fresh DO droplet brings up MyBooks single-app; `vibe status` reports healthy |
| 4 | Installer: ingress stack + multi-app mode + add Connect | `vibe install connect` on a host running MyBooks transitions to multi-app, both reachable at `/mybooks` and `/connect` |
| 5 | Installer: add TB and Payroll | All four apps coexist on one host; cookie / DB isolation verified |
| 6 | Installer: upgrade, uninstall, backup, doctor commands | Round-trip install → upgrade → uninstall on a throwaway droplet, no orphan volumes or networks |
| 7 | Cloudflare Tunnel integration in installer (optional per app, customer-owned token) | `vibe install mybooks --cloudflare-tunnel <token>` exposes the app via the customer's tunnel |
| 8 | Documentation + signed install script + public release | `curl ... \| sudo bash` from a clean Ubuntu 24.04 droplet → working four-app appliance in under 15 minutes |

---

## Verification

End-to-end smoke for the multi-app installer, run on a fresh DO droplet:

```bash
# Phase 1: bootstrap
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/vibe-installer/main/install.sh | sudo bash
vibe doctor                                    # all green

# Phase 2: single-app
sudo vibe install mybooks
curl http://<host>:5173/                       # MyBooks SPA
curl http://<host>:3001/api/v1/health          # 200

# Phase 3: promote to multi-app
sudo vibe install connect                      # prompts to switch modes; accept
sudo vibe install tb
sudo vibe install payroll
curl -k https://<host>/                        # landing page with 4 tiles
curl -k https://<host>/mybooks/api/v1/health   # 200
curl -k https://<host>/connect/api/health      # 200
curl -k https://<host>/tb/api/v1/health        # 200
curl -k https://<host>/payroll/api/health      # 200

# Phase 4: upgrade in place
sudo vibe upgrade mybooks --to 1.4.3
vibe status                                    # reports new version, healthy

# Phase 5: tear down one app, return to multi mode (3 apps)
sudo vibe uninstall payroll
vibe status                                    # 3 apps, mode=multi

# Phase 6: tear down to single
sudo vibe uninstall connect
sudo vibe uninstall tb
vibe status                                    # 1 app, mode=single — auto-demoted
```

DB and cookie isolation verified per app:

```bash
# DB isolation
sudo docker exec mybooks-postgres psql -U kisbooks -d kisbooks -c '\dt' | head
sudo docker exec connect-postgres psql -U vibe -d vibe_connect -c '\dt' | head
sudo docker exec tb-postgres      psql -U postgres -d vibe_tb_db -c '\dt' | head
sudo docker exec payroll-postgres psql -U vibept   -d vibept     -c '\dt' | head

# Cookie path
# In browser: log into MyBooks, devtools → Application → Cookies; confirm Path=/mybooks
# Visit /connect/ — confirm MyBooks cookies are NOT sent
```

---

## Known limitations & future work

1. **WebAuthn `rpId` shared across apps in multi-app mode.** Documented as known scoping limitation. Mitigation if it becomes painful: move just the passkey-using app to a subdomain (`mybooks.<host>`).
2. **No automatic horizontal scaling.** This is single-host appliance distribution. Multi-host clustering is out of scope; firms with that need are pointed at a managed offering.
3. **Local LLM (Qwen3-8B, etc.) not bundled by default.** Optional via `vibe install ollama` profile in a future phase. GLM-OCR ships as the only default local model because of its small footprint.
4. **Backup orchestration** (Duplicati) is configured per-app but the installer doesn't drive remote-target setup — operator runs through Duplicati's UI once.
5. **Single-firm assumption.** Multi-tenant hosting (multiple CPA firms on one host) is explicitly out of scope; per Kisaes' isolation principle, that's one host per firm.
