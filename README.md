# fnb-platform — Multi-Outlet F&B Management Platform

Monorepo layout for the four independently built and deployed applications
described in [fnb_multi_outlet_prd.md](./fnb_multi_outlet_prd.md):

| Application | Folder | Stack |
|---|---|---|
| HQ backend (API + worker) | `hq-backend/` | NestJS, TypeScript (ESM) |
| Outlet backend (API + sync worker) | `outlet-backend/` | NestJS, TypeScript (ESM) |
| HQ frontend | `hq-frontend/` | React 19, TanStack Start (SPA), Vite, Tailwind |
| Outlet POS frontend | `outlet-frontend/` | React 19, TanStack Start (SPA), Vite, Tailwind |

All projects use **pnpm** (pinned via `packageManager` in each `package.json`).

## Quick start (Docker)

```bash
cp .env.example .env   # then edit values (dev defaults are pre-filled)
docker compose up --build
```

This starts the full topology from PRD §14.2:

| Service | Purpose | Host URL |
|---|---|---|
| `hq-web` | HQ frontend (Nginx) | http://localhost:8080 |
| `hq-api` | HQ backend API | http://localhost:4000/api/v1 |
| `hq-worker` | HQ background worker | — |
| `hq-db` / `hq-redis` | HQ PostgreSQL / Redis (internal) | — |
| `outlet-a-web` | Outlet A POS frontend (Nginx) | http://localhost:8081 |
| `outlet-a-api` | Outlet A backend API | http://localhost:5000/api/v1 |
| `outlet-a-worker` | Outlet A sync worker (menu pull / outbox push) | — |
| `outlet-a-db` / `outlet-a-redis` | Outlet A PostgreSQL / Redis (internal) | — |

Health probes: `GET /api/v1/health` on each backend. Check status with
`docker compose ps` — all services should report `healthy`/`running`.

Two one-shot services run to completion **before** the APIs start:
`hq-migrate` and `outlet-a-migrate` apply the TypeORM migrations as a single
controlled job per database (PRD §14.2) — never concurrently on API replicas.

Swagger UI (local dev cluster only): http://localhost:4000/api/v1/docs (HQ)
and http://localhost:5000/api/v1/docs (Outlet A); machine-readable documents
at `/openapi.json`. The committed artifacts in
`*/openapi/openapi.json` are regenerated via `pnpm openapi:export`; keep
them in sync with endpoint changes (PRD §11).

Host-published datastores for non-Docker development and e2e tests
(loopback only): HQ PostgreSQL `localhost:15432`, HQ Redis `localhost:16379`,
Outlet A PostgreSQL `localhost:15433`, Outlet A Redis `localhost:16380`.

Network isolation (PRD §2):

- `hq-internal` — HQ API/worker/web + HQ DB/Redis
- `outlet-a-internal` — outlet A API/worker/web + outlet A DB/Redis
- `hq-sync` — the only path between environments; the **outlet worker** uses
  it to call the HQ sync API (`HQ_API_BASE_URL`). HQ has no route to any
  outlet database, and outlet sales never depend on HQ reachability.

Frontends are served by their own Nginx, which also reverse-proxies `/api/`
to their backend so the browser stays same-origin (no CORS exposure).

## Local development (without Docker)

Each project is independent — install and run from its own folder with pnpm:

```bash
# backends (hq-backend / outlet-backend)
pnpm install
pnpm start:dev      # HTTP API on :3000 (prefix /api/v1)
pnpm build && node dist/worker-main.js   # worker entrypoint

# frontends (hq-frontend / outlet-frontend)
pnpm install
pnpm dev            # Vite dev server on :3000
pnpm build          # SPA build -> dist/client (see vite.config.ts spa config)
```

Backends read `PORT`, `DATABASE_URL`, `REDIS_URL` (+ outlet identity and HQ
sync variables for the outlet worker; see each app's `.env.example` for the
full list). Every entrypoint runtime-validates its environment with Zod and
fails startup on missing/inconsistent values (PRD §14.1). The worker
entrypoints additionally require the HQ sync configuration. Logs are
structured JSON (one object per line) carrying `requestId` for every request
(PRD §13).

## Docker notes

- Backend images are multi-stage (pnpm via corepack → build → prod-deps
  runtime) and run as non-root. The **same image** runs the API (default
  `CMD`) and the worker (`command: node dist/worker-main.js` in compose).
- Frontend images build the Vite SPA and serve it via each app's own
  `nginx/nginx.conf` (static files + `/api/` reverse proxy + SPA fallback).
- TanStack Start is configured in SPA mode (`vite.config.ts`), producing a
  static bundle; the build stage copies the prerendered `_shell.html` to
  `index.html` for the Nginx `try_files` fallback.
- Per-service environment is centralized in the root `.env` (see
  `.env.example`). Never commit real secrets or bake them into images.
- Production: deploy HQ centrally and repeat the outlet stack once per site
  (own DB volume, Redis, API, worker, UI) with outbound HTTPS to HQ — see
  PRD §14.2 "Production topology".
