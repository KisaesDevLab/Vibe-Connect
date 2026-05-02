# Persistence — what survives `docker compose pull && up -d`

Operator reference for the data layout. Everything that matters is in
exactly three places. Lose any of them and you lose user-visible state;
keep all three on a backed-up volume and an upgrade is a no-op.

## TL;DR

| Path on host                              | Contents                                                                                                                            | Survives update? | Backup priority |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------- |
| `/var/lib/vibe/connect/postgres-data`     | Postgres data dir. Includes the firm key (`firm_keys`), every conversation key envelope, audit log, sessions, and Phase 26 vault metadata. | ✅                | **CRITICAL**    |
| `/var/lib/vibe/connect/uploads`           | Attachment + vault file ciphertext, encrypted avatars, tus partial-upload staging.                                                  | ✅                | **CRITICAL**    |
| `/var/lib/vibe/connect/tls`               | ACME-issued cert + key from the in-app ticker (only when `TLS_MODE=internal`).                                                      | ✅                | low (re-issuable) |
| `/etc/vibe/connect/.env`                  | `SESSION_SECRET`, `BACKUP_HEARTBEAT_TOKEN`, VAPID keys, provider creds.                                                            | ✅                | **CRITICAL**    |
| `/etc/vibe/connect/postgres_password`     | DB password (file mode 0600).                                                                                                       | ✅                | high            |

Compose-managed volumes (the `infra/docker/docker-compose.prod.yml`
shape) bind these paths into the containers; pulling a new image does
not touch the host paths.

## What survives an update

`docker compose pull && docker compose up -d` replaces the container
images with fresh layers. Anything inside a mounted volume / bind-mount
is preserved bit-for-bit. Anything inside the container's writable
layer is destroyed.

The only state the server writes is into the three paths above. There
is **no app-internal "data" directory** that lives outside a mount. If
you moved the bind-mount or forgot to declare it in compose, the server
will boot, run migrations against an empty Postgres, and present
`POST /install` as if this were a brand-new firm — that's the only
visible failure mode.

## What does NOT survive an update

- **In-flight HTTP / Socket.io connections.** Expected. Browser tabs
  reconnect within 2 seconds.
- **In-flight `tus` upload chunks** (vault uploads, attachment uploads).
  The client retries from the last acked offset. Any orphan chunks on
  disk are pruned by the daily sweep (`TUS_ORPHAN_TTL_HOURS`, default
  168h / 7 days) once they've sat unmodified.
- **The container's writable layer.** Nothing in this repo writes there
  on purpose; if a future change starts to, fix it before it ships.

## Operator footguns

### Rolling-restart schema skew

`infra/docker/docker-entrypoint.sh` runs `knex migrate:latest` on every
container start (unless `MIGRATIONS_AUTO=false`, which the appliance
overlay sets so the bootstrap drives migrations centrally).

In a two-replica deployment, replica B can apply a migration that
replica A — still on the old image — doesn't yet expect. Concretely:
**adding a NOT NULL column in v1.1.0** would let replica A's INSERTs
fail with `null value in column ... violates not-null constraint`
during the rolling cutover.

**Mitigation pattern:** never make a column NOT NULL in the same
release that introduces it. Split:

- v1.1.0 — add the column nullable + default; new INSERTs from new
  code populate it.
- v1.1.1 — backfill any NULLs, then ALTER TYPE ... SET NOT NULL.

Same pattern for renaming columns or types: introduce the new alongside
the old in v1.x, switch readers/writers in v1.x+1, drop the old in
v1.x+2.

Single-replica appliances aren't exposed to this — but they ARE exposed
to mid-restart `/health` blips while a long migration runs. Caddy's
default 5s probe and 3-strike threshold will mark Connect down for ~15s
on a heavy migration. That's a configurable thing on the Caddy side.

### `SESSION_SECRET` rotation orphans crypto-derived seals

`SESSION_SECRET` is the entropy source for the HKDF KEK chain in
`apps/server/src/services/kekSeal.ts`. Two pieces of state are sealed
under that KEK:

1. **Encrypted avatars** under `/var/lib/vibe/connect/uploads/avatars/`.
   They were written with a key derived from the OLD `SESSION_SECRET`;
   after rotation they cannot be decrypted.
2. **The ACME account key** in
   `firm_settings.tls_acme_account_key_sealed`. After rotation the
   server logs `tls.acme_seal_unwrap_failed` and proceeds to mint a new
   ACME account on the next renewal cycle. Customers using the in-app
   ACME ticker get a fresh account key — fine, but cert renewals will
   restart from "new account, no order history."

**Recovery procedure** is documented in
`docs/ops/SESSION_SECRET_ROTATION.md`. Read it before rotating.

### `SESSION_COOKIE_NAME` rotation invalidates every staff session

`SESSION_COOKIE_NAME` (default `vibe.sid`) is a cookie name, not a
secret. **Don't change it after install.** If you do, every existing
browser still presents the old cookie name and the server treats those
sessions as logged-out. Staff users get bumped to the login screen all
at once.

The portal cookie name is hardcoded in
`apps/server/src/routes/portal.ts:30` (literal `vibe.portal`), so portal
sessions are immune to env regeneration.

### `POSTFIX_RAW_BRIDGE_SECRET` falls back to the Postmark secret

`apps/server/src/env.ts:114` — when `POSTFIX_RAW_BRIDGE_SECRET` is
unset, it defaults to whatever `POSTMARK_INBOUND_WEBHOOK_SECRET` is.
This was a backwards-compat decision so installs that predate the
dedicated secret keep working.

The footgun: rotating the Postmark webhook secret silently breaks the
Postfix raw-MIME bridge if you didn't ALSO set the bridge secret
explicitly. Set both, even if to the same value, so a future Postmark
rotation doesn't leak the bridge.

### VAPID key reset invalidates push subscriptions

`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in env. Every browser that
ever subscribed to push notifications stored the public key with the
push service. Regenerating the keypair makes those subscriptions
forever-401 — the affected staff must visit Settings → Notifications
and re-enable. There's no in-app prompt; they just stop getting toasts.

If you need to rotate (suspected leak), accept that every staff member
must re-subscribe and budget a support ticket per active staff member.

### Postgres firm-key row loss = permanent E2EE data loss

The firm key lives in the `firm_keys` table, generated exactly once via
`POST /install` and shown to the operator as a 24-word recovery phrase.
**The phrase is the only out-of-DB copy of the firm private key.** If
both:

- The `firm_keys` row is gone (Postgres restored from a backup that
  predates `/install`, or volume nuked + no backup), AND
- The recovery phrase was lost (operator never wrote it down, or the
  paper went in the shredder)

then every encrypted message and vault file is permanently
unrecoverable. There is no support escalation path; no admin override
recovers the data. This is the failure mode the
`BACKUP_REQUIRED=true` + `/admin/key-status` machinery is designed to
warn about before it bites.

### Caddy path-rewrite + cookie path mismatch = silent login loop

If you front the appliance with a Caddy rule like:

```caddyfile
connect.firm.com {
    reverse_proxy /* vibe-connect-client:443
}
```

while leaving `BASE_PATH=/connect` and `SESSION_COOKIE_PATH=/connect`
in the appliance env, Express issues session cookies scoped to
`/connect` but the user's browser URL is `/`. The browser refuses to
send the cookie back, the server treats every request as anonymous,
and login loops forever. **There's no error in the logs** — every
request just looks like a fresh anonymous one.

Two ways to fix:

1. Drop `BASE_PATH` and `SESSION_COOKIE_PATH` to `/` and let Caddy mount
   the appliance at the subdomain root.
2. Have Caddy add the `/connect` prefix in the reverse proxy:
   `reverse_proxy /* vibe-connect-client:443/connect`. Set the
   `request.uri` rewrite to match.

Either is fine; the bug is mismatching them.

## Single-app vs appliance compose differences

| Knob                       | Single-app (`docker-compose.prod.yml`) | Appliance (`docker-compose.grouped.yml`) |
| -------------------------- | -------------------------------------- | ---------------------------------------- |
| `BASE_PATH`                | `/`                                    | `/connect`                               |
| `SESSION_COOKIE_PATH`      | `/`                                    | `/connect`                               |
| `TLS_MODE`                 | `internal` (in-app ACME)               | `external` (Caddy fronts)                |
| `MIGRATIONS_AUTO`          | `true` (default)                       | `false` (bootstrap-driven)               |
| `BACKUP_REQUIRED`          | `false` (default)                      | `true`                                   |
| `BACKUP_HEARTBEAT_TOKEN`   | unset                                  | required, ≥32 chars                      |
| Postgres ports             | `127.0.0.1:5435:5432` (psql access)    | published; container only                |
| App ports                  | `4000:4000` (host visible)             | not published; `vibe_ingress` network    |
| nginx ports                | `80/443/8443` published                | not published; `vibe_ingress` network    |

## Verification checklist before going to production

- [ ] All three host paths (`postgres-data`, `uploads`, `tls`) are on a
      filesystem that's getting snapshotted nightly.
- [ ] `/etc/vibe/connect/.env` is in the snapshot or version-controlled
      separately (it has `SESSION_SECRET` — treat it as a secret).
- [ ] The 24-word recovery phrase from `POST /install` is stored in
      offline cold storage, not in the same data center as the appliance.
- [ ] `BACKUP_HEARTBEAT_TOKEN` is set on the appliance AND on whatever
      runs the backup; a successful `POST /admin/backup-heartbeat`
      writes `last_backup_ok_at` and the banner clears.
- [ ] A "kill the VM, restore from snapshot, hit `/health`, send a test
      message, decrypt an old message" drill has been done at least once
      against this customer's appliance. Document the outcome.
