# syntax=docker/dockerfile:1
# Stages: deps -> dev (dev server + tests) -> build -> prod (runtime image)
FROM node:24-alpine AS base
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable

# Manifests only, so dependency layers stay cached across source edits.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

FROM deps AS dev
COPY . .

FROM dev AS build
# Rebuild node_modules with production deps only. Workspace links stay symlinks, so
# Node still type-strips @usage-monitor/contracts (it refuses .ts under node_modules).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm build \
 && find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --prefer-offline --store-dir /pnpm-store

FROM node:24-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "apps/server/src/main.ts"]
