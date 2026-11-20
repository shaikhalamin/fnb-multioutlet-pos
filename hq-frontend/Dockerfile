# syntax=docker/dockerfile:1
# Multi-stage build for the HQ frontend: Vite SPA build, then a static
# Nginx runtime that also reverse-proxies /api/ to the HQ backend.

# ---- build: Vite production build (SPA mode, see vite.config.ts) ----
FROM node:22-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build-time public config only; never embed machine secrets (PRD §14.1).
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm build && cp dist/client/_shell.html dist/client/index.html

# ---- runtime: Nginx static server + API reverse proxy ----
FROM nginx:1.27-alpine AS runtime
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/client /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
