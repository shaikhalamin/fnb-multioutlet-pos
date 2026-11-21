# fnb-platform — Multi-Outlet F&B Management Platform

Monorepo layout for the four independently built and deployed applications
described in [fnb_multi_outlet_prd.md](./fnb_multi_outlet_prd.md):

| Application | Folder | Stack |
|---|---|---|
| HQ backend (API + worker) | `hq-backend/` | NestJS, TypeScript (ESM) |
| Outlet backend (API + sync worker) | `outlet-backend/` | NestJS, TypeScript (ESM) |
| HQ frontend | `hq-frontend/` | React 19, TanStack Start (SPA), Vite, Tailwind — editorial design system ([DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)) |
| Outlet POS frontend | `outlet-frontend/` | React 19, TanStack Start (SPA), Vite, Tailwind — editorial design system ([DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)) |

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

## Phase 1 — HQ security & catalog (implemented)

Sign in to the HQ console at http://localhost:8080 with the seeded admin
(`admin@fnb.local` / `Admin123!` — override via `SEED_HQ_ADMIN_*` before
seeding). Phase 1 delivers (PRD §18):

- **HQ JWT auth with rotating refresh** — Passport strategies (bearer access,
  cookie refresh JWT) with two independent HS256 secrets, refresh tokens in an
  HttpOnly cookie scoped to `/api/v1/auth`, server-side `jti` tracking, CAS
  rotation, family revocation on reuse (AT-18), login rate limiting.
- **RBAC** — 11 permissions, 3 seeded roles; every route guarded
  server-side (`@RequirePermissions` + global `JwtAuthGuard`).
- **Users management** — `/api/v1/users`, `/api/v1/roles` + console UI.
- **Master menu** — `/api/v1/categories`, `/api/v1/menu-items` CRUD with
  archive tombstones; item edits fan out per-outlet `UPSERT`/`REMOVE`
  catalog changes atomically in the same transaction (PRD §8.2).
- **Outlets + assignments** — provision outlets (revision-0 row included),
  assign/unassign with price overrides; effective price = override ??
  default (FR-02/AT-02); no-op saves never burn a revision.
- **Outlet sync keys** — issue/rotate/revoke; 256-bit secret revealed
  exactly once, stored as a peppered HMAC (verified against `OUTLET_KEY_PEPPER`).

Seed (idempotent; also creates demo outlets A/B/C + items for AT-01/AT-02):

```bash
cd hq-backend && pnpm seed
```

Verification used in Phase 1: backend `pnpm test` (31 unit) and
`pnpm test:e2e` (18 e2e against real PostgreSQL/Redis — auth lifecycle,
AT-01 assignment fan-out, AT-02 override, RBAC denial, key lifecycle),
browser walkthrough of the console, and direct SQL checks of revisions,
change payloads, key hashes and audit rows.

## Phase 2 — Outlet operations (implemented)

Sign in to the Outlet A POS at http://localhost:8081 with a seeded account:
`manager@outlet-a.local` / `Manager123!`, `cashier@outlet-a.local` /
`Cashier123!`, `clerk@outlet-a.local` / `Clerk123!` (override via
`SEED_OUTLET_<ROLE>_EMAIL/PASSWORD` before seeding). Phase 2 delivers
(PRD §18):

- **Outlet JWT auth with rotating refresh** — mirror of the HQ session model
  with outlet-only secrets (`OUTLET_JWT_*`), the `outlet_rt` HttpOnly cookie,
  CAS rotation and family revocation on reuse; access tokens carry the
  `outletId` claim re-validated against this deployment on every request.
- **Local RBAC + user management** — 8 permissions, 3 seeded roles
  (`OUTLET_MANAGER` / `OUTLET_CASHIER` / `OUTLET_INVENTORY_CLERK`), local
  user CRUD at `/api/v1/users` + `/api/v1/roles`.
- **Catalog cache** — `GET /menu` serves the locally assigned catalog with
  effective prices, live stock and `meta.catalogRevision`/`lastCatalogSyncAt`;
  seeded to simulate a completed sync (the Phase-3 pull worker reconciles it).
- **Inventory** — `GET /inventory` + audited `POST /inventory/adjustments`
  (RESTOCK/WRITE_OFF/RECOUNT): row-locked, versioned, nonnegative, every
  movement records reason/actor/request ID (FR-04/FR-05).
- **Atomic idempotent sales** — `POST /sales` runs the exact PRD §8.6
  transaction: advisory-lock the idempotency key → offline-grace check
  (`SYNC_TEMPORARILY_UNAVAILABLE` past 72h) → catalog/price resolution →
  conditional stock decrements in deterministic order (insufficient stock ⇒
  409 with `{menuItemId, requestedQuantity, availableQuantity}` and full
  rollback) → receipt allocation (`A-000001`) → immutable snapshot lines →
  exactly one `sale.completed` outbox event (canonical-JSON SHA-256) →
  stored idempotency response. Same key + same body replays the stored
  receipt (AT-07); same key + different body ⇒ 409 `IDEMPOTENCY_KEY_REUSED`
  (AT-08). Money is `bigint` end to end, serialized as decimal strings.
- **Local sync status** — `GET /sync/status` (menu revision, grace state,
  outbox backlog) answered entirely from local tables; never calls HQ.
- **POS frontend** — login, POS menu/cart/checkout (one idempotency key per
  attempt, held across retries; totals only from the authoritative
  response), receipt confirmation/reprint, inventory adjustments, sales
  history + receipt detail, local user management, and a sync-status banner.
  All API access goes through Kubb-generated typed clients (Axios + Zod +
  TanStack Query) from the exported OpenAPI contract.

Seed (idempotent; identity, roles, demo users, fixed-UUID catalog with
burger/pizza/cola at 50/40/100 stock, counters, fresh sync state):

```bash
cd outlet-backend && pnpm seed          # or: docker compose run --rm outlet-a-api node dist/database/seed.js
```

Verification used in Phase 2: outlet-backend `pnpm test` (70 unit) and
`pnpm test:e2e` (24 e2e against the real outlet PostgreSQL/Redis — AT-03
atomic sale with SQL persistence asserts, AT-04 full rollback, AT-05
last-unit race, AT-06 100 concurrent sales with contiguous receipts,
AT-07/AT-08 idempotency, AT-11 grace expiry, AT-17-flavor persona denials,
AT-18 refresh reuse), a browser walkthrough of the POS (cashier checkout ⇒
receipt `A-000001`, clerk restock, manager user creation, sync banner
showing the pending upload), curl spot-checks of every error code, and
direct SQL checks of snapshots, movements, counters, the outbox payload
hash and the idempotency response JSON.

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

## Phase 3 — Synchronization (implemented)

The complete outlet ⇄ HQ synchronization loop (PRD §8, §18): typed HQ machine
client, menu pull + single-response snapshot, BullMQ dispatcher (sweep →
lease `FOR UPDATE SKIP LOCKED` → deliver), transactional HQ inbox with
per-event acks (`ACCEPTED` / `DUPLICATE` / `RETRYABLE_ERROR` /
`REJECTED_PERMANENT`), capped-backoff retries, hourly checkpoint
reconciliation, heartbeats, quarantine with manager replay, and the audited
emergency offline-grace override.

### Machine-key provisioning loop (PRD §9.2)

Outlets sync with HQ only after a real key is provisioned:

```bash
docker compose up -d hq-db hq-api hq-migrate        # 1. HQ first (migrate + seed)
SEED_ISSUE_OUTLET_KEYS=1 pnpm --dir hq-backend seed # 2. prints keyId.secret ONCE per outlet
# 3. paste the pair into root .env (OUTLET_A_HQ_KEY_ID / _SECRET), then:
docker compose up -d outlet-a-worker                # 4. the sync loop starts
```

`SEED_ISSUE_OUTLET_KEYS` is off by default; issuance is idempotent (outlets
holding an ACTIVE, unexpired key are skipped). The seed pins well-known demo
UUIDs for outlets A/B/C and the three demo items so the HQ seed, the outlet
seed and root `.env` agree on identity.

### What the loop guarantees (verified by drills + e2e)

- **Sales never wait on HQ** (AT-10/AT-11): during a full `docker stop
  fnb-platform-hq-api-1` outage, POS sales kept committing with sequential
  receipts (`A-001145..147`), `/sync/status` showed the growing backlog, the
  worker backed off (`HQ_UNREACHABLE` → capped exponential backoff honoring
  `Retry-After`), and the backlog drained within seconds of restart with zero
  duplicates at HQ.
- **Exactly-once HQ effects** (AT-09/AT-15): re-posting a delivered batch
  returns `DUPLICATE` with a single `hq_sales` projection; the same `eventId`
  with a different payload is `REJECTED_PERMANENT` (`EVENT_ID_CONFLICT` +
  security audit) and never overwrites the original.
- **Atomic menu apply** (AT-13/AT-14): a mid-apply failure commits nothing
  and never advances the checkpoint; a deleted change history (gap) triggers
  the single-response snapshot — upserts, tombstones for absent items,
  checkpoint pinned to `snapshotRevision`.
- **Offline grace** (AT-12/AT-19, §8.8): stale sync (73 h) blocks sales with
  `503 SYNC_TEMPORARILY_UNAVAILABLE`; a manager's audited override
  (`POST /sync/grace-override`, banner → dialog) rescues sales; HQ price
  changes alter only future sales — receipts keep their snapshot prices.
- **Identity is server-derived** (AT-16/AT-17): the outlet scope comes only
  from the key record; events claiming another outlet reject the whole batch
  (403); cashiers cannot apply overrides; `/sync/v1/*` sends no CORS headers.
- **Restore safety** (AT-22): replaying events from a restored outlet backup
  is all-`DUPLICATE` at HQ — receipt numbers and projections stay consistent.

HQ-side surfaces: `GET /sync/v1/menu/changes|snapshot`, `POST
/sync/v1/events/batch`, `GET /sync/v1/checkpoint`, `POST
/sync/v1/heartbeat` (machine key; 600/min throttle; envelope + `X-Request-Id`
everywhere) and `GET /outlets/:id/sync-status` (human `sync.read`).
Outlet-side surfaces: `GET /sync/status`, `POST /sync/grace-override`,
`POST /sync/outbox/:eventId/replay` (manager `sync.override`).

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
