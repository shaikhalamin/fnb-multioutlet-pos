# syntax=docker/dockerfile:1
# Multi-stage build for the outlet backend. A single image serves both the API
# (default CMD) and the outlet sync worker (compose overrides the command with
# `node dist/worker-main.js`) per PRD §14.2. Deployed once per outlet site.

# ---- base: enable pnpm via corepack ----
FROM node:22-alpine AS base
ENV CI=true
RUN corepack enable
WORKDIR /app

# ---- deps: full dependencies for building ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- prod-deps: runtime dependencies only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- build: compile TypeScript ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# ---- runtime: API + worker image ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
