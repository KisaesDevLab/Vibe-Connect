# syntax=docker/dockerfile:1.7
# Vibe Connect nginx image.
#
# Multi-stage: build apps/web and apps/portal from source, then copy the
# compiled dist/ outputs into an nginx image that also runs an inotify loop
# to reload the daemon when tlsAcme drops new certs.
#
# Build context is the repo root (see docker-compose.prod.yml). .dockerignore
# keeps node_modules / .git / .env out of the upload step.

# --- deps -----------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json yarn.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/portal/package.json apps/portal/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/crypto/package.json packages/crypto/
RUN yarn install --frozen-lockfile

# --- build frontend -------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
# packages/crypto and packages/shared-types must build before apps consume them.
RUN cd packages/shared-types && npx --no-install tsc -b --force && ls dist | head -3
RUN cd packages/crypto && npx --no-install tsc && ls dist | head -3
RUN yarn workspace @vibe-connect/web build
RUN yarn workspace @vibe-connect/portal build

# --- nginx runtime --------------------------------------------------------
FROM nginx:1.27-alpine
RUN apk add --no-cache inotify-tools
COPY infra/docker/nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Bake in the frontend bundles. docker-compose no longer bind-mounts
# ./static because that path is now a build artefact, not a tracked dir.
COPY --from=build /app/apps/web/dist /usr/share/nginx/html/web
COPY --from=build /app/apps/portal/dist /usr/share/nginx/html/portal
ENTRYPOINT ["/entrypoint.sh"]
