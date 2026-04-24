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
# Single install — workspace postinstall scripts are safe to run here and the
# previous two-pass (ignore-scripts + redo) was a leftover from when a
# package had a broken postinstall. Keep the flag off so bcrypt/libsodium
# native bindings compile once.
RUN yarn install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN cd packages/shared-types && npx --no-install tsc -b --force && ls dist | head -3
RUN cd packages/crypto && npx --no-install tsc && ls dist | head -3
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
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /app/packages/crypto/package.json packages/crypto/package.json
COPY --from=build /app/packages/crypto/dist packages/crypto/dist
COPY --from=build /app/node_modules node_modules
# Strip devDependencies from the runtime image. The build stage needs tsx,
# vite, typescript, vitest, eslint, etc. — the runtime container needs
# exactly none of them. Pruning ~200 MB of tooling both shrinks the image
# and removes a supply-chain surface (tsc-watch et al. have shipped CVEs
# in the past and wouldn't be reachable here post-prune).
RUN yarn install --production --frozen-lockfile --ignore-scripts \
    && yarn cache clean
# Rewrite workspace package.json entry points to the compiled dist/ so Node can
# resolve them at runtime (source package.json points at ./src/*.ts for dev).
RUN node -e "const fs=require('fs'),path='packages/crypto/package.json',p=require('./'+path);\
p.main='./dist/index.js';p.types='./dist/index.d.ts';\
p.exports={'.':{'types':'./dist/index.d.ts','default':'./dist/index.js'},\
'./server':{'types':'./dist/server.d.ts','default':'./dist/server.js'},\
'./browser':{'types':'./dist/browser.d.ts','default':'./dist/browser.js'},\
'./bip39':{'types':'./dist/bip39.d.ts','default':'./dist/bip39.js'}};\
fs.writeFileSync(path,JSON.stringify(p,null,2));" \
  && node -e "const fs=require('fs'),path='packages/shared-types/package.json',p=require('./'+path);\
p.main='./dist/index.js';p.types='./dist/index.d.ts';\
p.exports={'.':{'types':'./dist/index.d.ts','default':'./dist/index.js'}};\
fs.writeFileSync(path,JSON.stringify(p,null,2));"
RUN mkdir -p /app/uploads && chown -R vibe:vibe /app/uploads
USER vibe
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
