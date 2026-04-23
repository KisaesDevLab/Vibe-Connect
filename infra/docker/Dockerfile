# syntax=docker/dockerfile:1.7
# Multi-stage appliance image: server + web + portal in one container, Alpine-based.

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
RUN yarn install --frozen-lockfile --ignore-scripts && yarn install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN yarn workspace @vibe-connect/shared-types build || true
RUN yarn workspace @vibe-connect/crypto build || true
RUN yarn workspace @vibe-connect/server build
RUN yarn workspace @vibe-connect/web build
RUN yarn workspace @vibe-connect/portal build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S vibe && adduser -S vibe -G vibe
ENV NODE_ENV=production
ENV PORT=4000
# Copy only what we need at runtime.
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/knexfile.cjs apps/server/knexfile.cjs
COPY --from=build /app/apps/server/src/db/migrations apps/server/src/db/migrations
COPY --from=build /app/apps/server/src/db/seeds apps/server/src/db/seeds
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/portal/dist apps/portal/dist
COPY --from=build /app/packages/shared-types/package.json packages/shared-types/package.json
COPY --from=build /app/packages/crypto/package.json packages/crypto/package.json
COPY --from=build /app/node_modules node_modules
RUN mkdir -p /app/uploads && chown -R vibe:vibe /app/uploads
USER vibe
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
