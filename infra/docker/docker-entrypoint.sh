#!/bin/sh
# Vibe Connect — Docker entrypoint.
#
# Runs pending knex migrations against the configured Postgres before
# starting the server. Without this, a fresh install lands at a server
# whose first GET /install/status query against `firm_keys` returns 500
# because the schema hasn't been created — the SPA's InstallGate then
# shows the "Can't reach the server" screen and the operator never sees
# the install wizard.
#
# Idempotent: knex tracks applied migrations in the `knex_migrations`
# table, so a re-deploy or container restart is a fast no-op once the
# schema is current. A failing migration exits non-zero before the
# server starts so a partially-migrated state never serves traffic;
# `restart: unless-stopped` will retry and the operator sees the failure
# in `docker logs`.
#
# Lifted from the trial-balance-app's `server/docker-entrypoint.sh`
# pattern; the two scripts stay close in shape so a fix to one is easy
# to backport to the other.

set -e

cd /app/apps/server

# MIGRATIONS_AUTO opt-out. Default `true` keeps the standalone first-boot
# flow working (operator does `docker compose up -d`, server is ready). The
# Vibe-Appliance overlay sets this to `false` so the appliance bootstrap
# can serialize migrations across multiple Vibe apps that share one
# Postgres — running them in parallel from each container's entrypoint
# races the `knex_migrations` row insert and surfaces as "Migration
# directory is corrupt" or duplicate-key errors at random.
if [ "${MIGRATIONS_AUTO:-true}" = "true" ]; then
  echo "[entrypoint] running pending migrations..."
  # `npx --no-install knex` finds the knex CLI in the repo's hoisted
  # node_modules without re-resolving from the registry — the runtime
  # image has yarn install --production already, so knex (a production
  # dep) is on disk. --no-install fails fast if it isn't, instead of
  # trying to fetch from npmjs.org with no network.
  npx --no-install knex --knexfile ./knexfile.cjs migrate:latest
else
  echo "[entrypoint] MIGRATIONS_AUTO=${MIGRATIONS_AUTO} — skipping migrations (appliance-managed)."
fi

echo "[entrypoint] starting Vibe Connect server..."
exec node dist/index.js
