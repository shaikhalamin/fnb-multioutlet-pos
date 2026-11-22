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

## Fresh clone → running system (Docker)

Prerequisites: git and Docker Engine with Compose v2 (`docker compose
version`). Node/pnpm are **not** required for this flow — every command below
runs inside the built images. They are only needed for
[local development without Docker](#local-development-without-docker).

### One-shot alternative

`./setup_env` runs steps 1–5 in one go: it copies each `.env.example` to `.env`
(existing files are kept), builds the images, starts the stack — the
`hq-migrate` / `outlet-a-migrate` jobs apply the migrations automatically
before the APIs start — seeds HQ with key issuance, wires outlet A's printed
keyId/secret pair into `.env` automatically, restarts `outlet-a-worker`, and
seeds Outlet A. If outlet A already holds an ACTIVE key (re-run), no new pair
is issued and the script says so — rotate via the HQ console if the secret was
lost.

### 1. Clone and configure

### 1. Clone and configure

```bash
git clone <repo-url> && cd fnb-platform
cp .env.example .env                                 # required — drives docker compose
cp hq-backend/.env.example hq-backend/.env           # optional — host-side dev + seed CLI
cp outlet-backend/.env.example outlet-backend/.env   # optional — host-side dev + seed CLI
cp hq-frontend/.env.example hq-frontend/.env         # optional — defaults already apply
cp outlet-frontend/.env.example outlet-frontend/.env # optional — defaults already apply
```

- The **root `.env` is the only one the Docker flow needs**: Compose injects
  every container's environment from it, and app-level `.env` files are never
  read inside the images. Its pre-filled values boot the full stack as-is —
  the placeholder secrets already satisfy each backend's runtime Zod
  validation; replace them before exposing the environment beyond loopback.
  Every variable referenced by `docker-compose.yml` is documented there.
- The **backend** `.env` files are for running pnpm commands from those
  folders (`pnpm start:dev`, `pnpm seed`, `pnpm migration:run`,
  `pnpm test:e2e`). They target the Compose-published datastores
  (`localhost:15432`/`16379` for HQ, `15433`/`16380` for Outlet A), so start
  those first: `docker compose up -d hq-db hq-redis outlet-a-db outlet-a-redis`.
- The **frontend** `.env` files are optional: the apps talk same-origin
  `/api/v1` everywhere — the Vite dev proxy locally and the Nginx reverse
  proxy in the container — so `pnpm dev` needs no configuration to reach the
  Compose-published backends.

### 2. Build and start

```bash
docker compose up --build -d
```

- The four app images (`fnb/hq-backend:local`, `fnb/outlet-backend:local`,
  both frontends) are built locally and tagged — nothing is pulled from a
  registry for them; only `postgres:17-alpine` / `redis:7-alpine` come from
  Docker Hub.
- The one-shot `hq-migrate` / `outlet-a-migrate` jobs apply the TypeORM
  migrations **before** the APIs start (single controlled job per database,
  PRD §14.2); `hq-api` additionally gates on Redis health.
- Wait for readiness: `docker compose ps` — every long-running service should
  report `healthy`/`running` (health probe: `GET /api/v1/health` per backend).

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

(All host ports are configurable via the root `.env`.)

### 3. Seed HQ

One idempotent command seeds the HQ admin plus the demo outlets A/B/C with
demo items:

```bash
docker compose run --rm hq-api node dist/database/seed.js
```

- HQ console login it creates: `admin@fnb.local` / `Admin123!` (override via
  `SEED_HQ_ADMIN_EMAIL` / `SEED_HQ_ADMIN_PASSWORD` on the seed run).
- Machine keys are **never** seeded: issuing one is a deliberate admin action
  in the console (shown once, PRD §9.2) — that's step 4 below.

### 4. Pair the outlet terminal with HQ (the UI flow)

Outlet terminals start **unprovisioned** — identity and the HQ machine key
arrive through the setup wizard, not environment variables (PRD §8.7, §9.2).
The whole flow is demo-able from the two UIs:

1. **Create the outlet in HQ** — http://localhost:8080 → *Outlets* → fill the
   create form (code/name/timezone). The pairing panel that appears shows the
   **Outlet ID + code** with copy buttons.
2. **Provision the terminal** — open http://localhost:8081/setup and paste the
   **Outlet ID + code** (step 1 of the wizard), plus the first admin
   account for that POS. The backend writes identity, receipt counters, the
   sync checkpoint and the admin in one transaction and seals itself.
3. **Issue the key in HQ** — the outlet's detail page → assign menu items →
   *API keys → Issue key*. Copy the one-time **key ID + secret**.
4. **Pair** — back in the wizard's step 2, paste the HQ base URL
   (`http://hq-api:3000/api/v1` inside Compose — pre-filled) plus the key
   pair and hit **Test & pair**. HQ validates the key live (a key minted for
   another outlet is refused), the pairing is saved in the outlet's own
   database, and the sync worker picks it up **without a restart**.

Until pairing the worker logs `awaiting_provisioning` once per cycle and its
HQ calls are refused. **POS sales work regardless once the catalog has synced**
— an outlet sale never depends on HQ (PRD §2); only menu pull / event push
wait for the key. Key rotation later: HQ console → *Rotate* → outlet POS →
*Sync* page → *Rotate the HQ key* (same live validation, no restart).

### 5. Log in and verify

| URL | What |
|---|---|
| http://localhost:8080 | HQ console — `admin@fnb.local` / `Admin123!` |
| http://localhost:8081 | Outlet A POS — the admin account you chose in the wizard |
| http://localhost:4000/api/v1/docs | HQ Swagger UI (local dev cluster only) |
| http://localhost:5000/api/v1/docs | Outlet A Swagger UI (local dev cluster only) |

Quickest end-to-end check: assign items to your outlet in HQ, wait one menu
pull (~30s), stock the items on the POS *Inventory* page, ring up a sale,
then watch it appear on the HQ dashboard within a few sync cycles (HQ reports
disclose `dataAsOf` while they wait). The POS sync-status banner and
`GET /api/v1/sync/status` show menu revision and outbox backlog locally.

> Local, UI-less development: `outlet-backend` still ships a dev seed
> (`pnpm seed`) that provisions a fixed demo identity plus demo users/catalog
> directly — useful for backend work without the wizard. The Compose cluster
> intentionally does **not** run it.

### Reset / teardown

```bash
docker compose down        # stop the stack, keep all data volumes
docker compose down -v     # also wipe both databases and queues (irreversible)
```

Reset only outlet A (to re-demo the pairing wizard; wipes its database):

```bash
docker rm -f fnb-platform-outlet-a-db-1
docker volume rm fnb-platform_outlet-a-db-data
docker compose up -d
```

After `down -v`, repeat from step 2 (images are retained; re-seeding is
required).

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

Seed (idempotent; fixed demo identity, roles, demo users, fixed-UUID catalog
with burger/pizza/cola at 50/40/100 stock, counters, fresh sync state) — the
UI-less local development path; the production path is the setup wizard
(step 4 above), and the seed never overwrites an existing identity row:

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
  it to call the HQ sync API (base URL + machine key stored in the outlet's
  `hq_connection` table — see the pairing flow in step 4). The outlet API
  joins this network only for the setup wizard's one-time live key
  validation. HQ has no route to any outlet database, and outlet sales never
  depend on HQ reachability.

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

### Machine-key provisioning (PRD §9.2)

Outlets sync with HQ only after a real key is provisioned — and provisioning
is now fully UI-driven (step 4 of
[Fresh clone → running system](#fresh-clone--running-system-docker) above):

1. HQ console → *Outlets* → create the outlet → copy its **Outlet ID + code**
   from the pairing panel.
2. Outlet POS → `/setup` → paste ID + code + the first admin (step 1 of the
   wizard; identity, counters and the admin commit in one transaction, then
   the endpoint seals permanently).
3. HQ console → the outlet's page → *API keys → Issue key* → copy the
   one-time **key ID + secret**.
4. Outlet POS → wizard step 2 → **Test & pair**. The outlet backend calls
   HQ's checkpoint endpoint with the candidate key (refusing a key minted
   for a different outlet), stores the pairing in its own `hq_connection`
   table, and the worker reads it from there — no environment variables, no
   restart. Later rotations use the same live validation via the POS *Sync*
   page (`PUT /api/v1/sync/hq-connection`, `sync.manage`).

The HQ seed deliberately does **not** issue keys (issuing one is a deliberate
admin action, FR-10); it pins well-known demo UUIDs for outlets A/B/C and the
three demo items so the demo data stays consistent.

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

## Phase 4 — Reporting & hardening (implemented)

Cross-outlet reporting, staleness disclosure, audit views and load/security
depth (PRD §10, §18; backup/recovery and production rollout omitted by
decision).

### Reports (PRD §10, computed on request from indexed HQ projections)

- `GET /reports/revenue-by-outlet?from=&to=&currency=` (`reports.read`):
  per-outlet completed revenue/count as decimal-string `bigint` sums. **Every
  ACTIVE outlet appears** — zero-sale outlets carry `"0"` and a null
  `lastIngestedAt`, never an omission.
- `GET /reports/outlets/:id/top-items?from=&to=&limit=5` (`reports.read`):
  `quantitySold DESC` with `menu_item_id` tie-break; `itemName` joins the
  current master name and falls back to the sale-time snapshot for items no
  longer in the master catalog (AT-19).
- **Staleness contract (AT-20):** every report carries `dataAsOf` = global
  max `ingested_at` and `isProvisional` = true while any ACTIVE outlet
  reports an outbox backlog or has never ingested a sale. Windows are UTC
  (`from` inclusive, `to` exclusive), bounded to 366 days (§15); unlike
  currencies are never summed.
- HQ frontend: `/reports` (Zod-validated date filters, top-items outlet
  picker) and a dashboard revenue card + outlet health grid (menu revision,
  watermarks, backlog/never-reported/heartbeat-stale states) wired to
  `GET /outlets/:id/sync-status`.

### Audit (PRD §11 audit views)

- `GET /audit/logs` (`audit.read`, a new HQ_SUPER_ADMIN-only permission —
  re-run `pnpm --dir hq-backend seed` on existing databases): immutable,
  newest-first listing with action/actor/entity/occurred_at filters and
  deterministic `(occurred_at, id)` cursor paging.
- HQ frontend `/audit`: cursor-paginated table with load-more and filters
  (the envelope's `meta.nextCursor` is promoted to an `x-page-cursor`
  response header by the shared axios layer — the one envelope-unwrap point).
- Retention stays disabled by default (`AUDIT_LOG_RETENTION_DAYS=0`,
  immutable trail); the HQ worker's hourly timer deletes in ≤1000-row
  batches only when configured.

### Verification evidence (AT-17, AT-20, §16)

- AT-20 drill (live compose): POS sale at Outlet A with `hq-api` stopped
  (receipt A-003455, outbox RETRY with backoff) → restart → report showed
  stale `dataAsOf` + `isProvisional: true` with the sale uncounted → after
  drain, report totals matched SQL `SUM(total_minor)` exactly (1286700 /
  3477 for the day) and Outlet B rendered "never reported", never "0 sales".
- AT-02/AT-19: sale at a 777-minor price override survived the HQ price
  revert — the HQ projection kept `unit_price_minor = 777` for that receipt.
- AT-17: forged-token matrix (wrong secret / issuer / audience / expired /
  disabled user → 401), §9.3 matrix spot-checks (analyst reports OK but no
  audit/menu-write; menu manager no keys/reports/audit; cashier no
  adjustments), human/machine credential crossover rejected both ways,
  machine routes send no CORS headers, and deployed frontend bundles grep
  clean of secrets.
- E2e suites: hq-backend 57 specs (incl. `reporting`/`audit`/`security`),
  outlet-backend 48 specs (incl. forged-token matrix and 503/429+Retry-After
  delivery failures) against real PostgreSQL/Redis.

### Sale-load baseline (PRD §16 — subject to host hardware)

`pnpm --dir outlet-backend perf:sale` (autocannon; fresh Idempotency-Key +
X-Request-Id per request; stock pre-restocked through the audited
adjustments path). Raise the outlet API throttle for the run:

```bash
OUTLET_A_THROTTLE_LIMIT=1000000 docker compose up -d outlet-a-api
pnpm --dir outlet-backend perf:sale --duration 60 --connections 25
```

(The recorded baseline and post-run integrity results live in
`outlet-backend/README.md`.)

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
