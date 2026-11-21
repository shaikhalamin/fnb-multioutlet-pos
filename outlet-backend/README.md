# outlet-backend

Outlet-side NestJS application (POS API + sync worker entrypoints) for the
multi-outlet F&B platform — see the root
[PRD](../fnb_multi_outlet_prd.md) for the full architecture.

Each outlet site runs this application against its own PostgreSQL and Redis:
catalog cache, inventory, atomic sales/receipts and the transactional outbox
land in Phases 2–3. The worker is the *only* component that talks to HQ, and
only outbound.

## Entrypoints

| Entry | File | Purpose |
|---|---|---|
| API | `src/main.ts` | HTTP API under `/api/v1` (health, docs) |
| Worker | `src/worker-main.ts` | Menu pull / outbox dispatch / delivery / reconcile (queues land in Phase 3) |
| Migrations | `src/database/migrate.ts` | `run` / `revert` / `show` via `scripts/migrate.sh` |

## Commands (pnpm via corepack)

```bash
corepack enable
pnpm install
pnpm start:dev        # dev server (loads .env if present)
pnpm build && pnpm start:prod
pnpm start:worker
pnpm lint && pnpm test
pnpm test:e2e         # needs DATABASE_URL, REDIS_URL, OUTLET_ID, OUTLET_CODE
pnpm migration:run    # apply migrations (tsx locally; dist in images)
pnpm openapi:export   # regenerate openapi/openapi.json after endpoint changes
```

## Configuration

Config parse → Zod validation → module → typed access (PRD §14.1):

- `src/config/env.schema.ts` — the Zod schema and `Env` type, plus
  entrypoint profiles: both validate the outlet identity (`OUTLET_ID` UUID,
  `OUTLET_CODE`), database/Redis URLs and the offline grace period; the
  **api** profile additionally requires the `OUTLET_JWT_*` secrets, while
  the **worker** profile requires `HQ_API_BASE_URL` and the HQ machine key
  (`HQ_OUTLET_KEY_ID/SECRET`) — neither entrypoint can be provisioned with
  the other's credentials (PRD §3, §9.2).
- `src/config/configuration.module.ts` — global `ConfigurationModule`
  (`ConfigModule.forRoot` with `isGlobal`, `cache`, the Zod `validate` hook
  and `envFilePath: ['.env.local', '.env']`; real environment variables
  always win).
- Typed access everywhere via `ConfigService<Env, true>` with
  `config.get('KEY', { infer: true })` (see `DatabaseModule` and the health
  Redis provider); worker sync knobs are mapped in
  `src/config/hq-sync.config.ts`.

The key secret never appears in logs; the worker log line prints only the
key ID (PRD §9.2). See [.env.example](./.env.example).

## Phase 0 foundation

- **Envelope contract** — `ApiSuccess`/`ApiError` with stable error codes and
  `requestId` (PRD §7.1, §12), identical to the HQ backend.
- **Request IDs + JSON logs** — same AsyncLocalStorage-based structured
  logging as HQ (PRD §13).
- **Health** — `GET /api/v1/health` probes the outlet PostgreSQL and Redis.
- **Migrations** — TypeORM with `synchronize: false`; compose runs the single
  `outlet-a-migrate` job before the outlet API starts (PRD §14.2).
- **OpenAPI** — Swagger UI at `/api/v1/docs` + `/openapi.json` when
  `SWAGGER_ENABLED=true`; committed artifact feeds the `outlet-frontend`
  Kubb pipeline (PRD §11).
- **Sync contract** — `src/contracts/sync-event-v1.schema.json` (PRD §8.4),
  identical to the hq-backend copy.

## Phase 2 — outlet operations

Modules under `src/modules/` (layered per PRD §5: controller → service →
repository, transactions always owned by the service):

| Module | Routes / role | Purpose |
|---|---|---|
| `auth` | `POST /auth/login\|refresh\|logout` | Rotating refresh sessions in the `outlet_rt` HttpOnly cookie; tokens carry the `outletId` claim re-checked against `OUTLET_ID` every request (PRD §9.1). |
| `users` | `GET/POST /users`, `PATCH /users/:id`, `GET /roles` | Local staff management (`users.read`/`users.write`). |
| `menu-cache` | `GET /menu` | Active local catalog + effective prices + live stock, `meta.catalogRevision`/`lastCatalogSyncAt` via the envelope `withMeta` hook (PRD §7.3). |
| `inventory` | `GET /inventory`, `POST /inventory/adjustments` | Row-locked, versioned, nonnegative balances; every movement audited with reason/actor/request ID (FR-04/FR-05). |
| `sales` | `POST /sales`, `GET /sales`, `GET /sales/:id` | The protected core (PRD §8.6) — one transaction, deterministic lock order, BigInt money, idempotent replay/409, offline-grace enforcement (§8.8). |
| `receipts`, `outbox` | — | Receipt counter and per-outlet event sequence allocation + the immutable `sale.completed` writer (canonical-JSON SHA-256). |
| `sync` | `GET /sync/status` | Local-only checkpoint + outbox backlog; never calls HQ. |

The sale transaction (PRD §8.6, FR-06): advisory-lock the idempotency key →
replay or `IDEMPOTENCY_KEY_REUSED` → grace check → catalog resolution
(`ITEM_NOT_ASSIGNED`/`ITEM_INACTIVE`) → conditional stock decrements in
sorted item order (`INSUFFICIENT_STOCK` + full rollback) → audited
movements → receipt allocation → snapshot lines → exactly one outbox event
→ stored idempotency response → COMMIT. No queue or HTTP calls inside the
transaction; the Phase-3 dispatcher picks the outbox up asynchronously.

Phase-2 migration `1720000000000-outlet-phase2-core.ts` creates every PRD
§6.2 table except `sync_attempt_logs` (Phase 3): identity, users/RBAC,
refresh sessions, catalog cache + sync state, balances/movements (with the
§6.2 CHECK constraints; the `stock_movements → sales` FK is deferred so the
§8.6 step order holds), receipt/outbox counters, sales + immutable lines +
idempotency keys, and the outbox (unique `(outlet_id, sequence_no)`, partial
due-index, jsonb sale-id expression index).

Seed (`pnpm seed`, idempotent): identity from `OUTLET_ID`/`OUTLET_CODE`,
permission catalog + 3 default roles, demo staff (manager/cashier/clerk),
a fixed-UUID catalog (BURGER-01 `"1000"`, PIZZA-01 `"1500"`, COLA-01
`"300"`) at 50/40/100 stock simulating a completed sync
(`applied_revision = 1`, fresh `last_sync_at`), and both counters at 1.

Verification: `pnpm lint && pnpm test` (70 unit specs) and `pnpm test:e2e`
(24 specs against the real outlet PostgreSQL/Redis covering AT-03…AT-08,
AT-11 grace expiry, AT-17 persona denials and AT-18 refresh reuse).

## Phase 3 — sync worker (PRD §8, §13)

`pnpm start:worker` runs the outlet-initiated loop (jobs carry event IDs
only; the DB sweeper — not BullMQ scheduling — is the source of truth for
retry eligibility):

- **menu-pull** (30 s): `MenuPullService` pulls deltas, verifies the reply's
  outlet identity, applies the whole page + checkpoint in ONE transaction;
  gaps route to the single-response snapshot rebuild (AT-13/AT-14).
- **outbox-dispatch** (5 s): expire stalled leases → lease due rows
  `FOR UPDATE SKIP LOCKED` → enqueue IDs to `sync-delivery`.
- **sync-delivery**: `HqSyncClient` (Kubb-generated, key injected server-side,
  every reply Zod-parsed) pushes batches; `ACCEPTED`/`DUPLICATE` → DELIVERED,
  retryable faults → capped backoff (honors `Retry-After`), permanent
  conflicts → QUARANTINED + audit alert — never deleted.
- **sync-reconcile** (hourly): compares HQ's checkpoint missing ranges with
  the local outbox and re-leases only real rows.

Manager surface (`sync.override`, audited in `outlet_audit_logs`):
`POST /sync/grace-override` (§8.8 emergency window extension; the sale path
honors `max(last_sync_at + OFFLINE_GRACE_HOURS, grace_overridden_until)`)
and `POST /sync/outbox/:eventId/replay`; `GET /sync/status` surfaces the
override, backlog and quarantined-error samples.

## Phase 4 — sale-load harness (PRD §16)

`pnpm perf:sale` (`scripts/perf/sale-load.ts`, tsx + pinned `autocannon`
devDependency) drives dynamic-body concurrent sales against a running outlet
API and asserts the local-sale latency target. Every request mints a fresh
`Idempotency-Key` + `X-Request-Id` and a rotating item/quantity mix (replayed
bodies would return cached idempotent 201s and fake the numbers); stock is
pre-restocked through the audited `POST /inventory/adjustments` path
(`reason: "RESTOCK"`, `perf-` request ids) so balances never bind mid-run.
Credentials come from `--email/--password` or `PERF_EMAIL/PERF_PASSWORD` and
are never printed. The process exits non-zero when any request errors,
any response is non-2xx, or p95 exceeds the threshold (default 500 ms,
PRD §16 — subject to hardware).

Run against the compose `outlet-a-api` (the API's global 100/min/IP throttle
must be raised for the run via the env knob, not code):

```bash
OUTLET_A_THROTTLE_LIMIT=1000000 docker compose up -d outlet-a-api
cd outlet-backend && pnpm perf:sale --duration 60 --connections 25
```

Flags: `--url` (default `http://127.0.0.1:5000/api/v1`), `--duration` (s,
default 30), `--connections` (default 10), `--rate` (optional req/s cap),
`--p95-threshold` (ms, default 500), `--max-quantity` (default 5),
`--restock-target` (default 0 = auto: sized to `duration × 2400` units per
item so stock never binds mid-run).

Post-run integrity checks live in the root README's Phase 4 verification
notes (duplicate receipts, oversells, outbox completeness, HQ totals).

### Recorded baseline (2026-11-21, Docker Desktop VM on the dev host — §16
target p95 < 500 ms, subject to hardware)

Flags: `--duration 60 --connections 25` against compose `outlet-a-api`
(`OUTLET_A_THROTTLE_LIMIT=1000000`), autocannon with per-request fresh
`Idempotency-Key`/`X-Request-Id` and a rotating 1–2-line item mix; stock
pre-restocked through the audited adjustments path:

```
requests:    9,727 (162.1 req/s)   statuses: 201×9727
p50 / p95 / p99: 142 ms / 246 ms / 351 ms
errors: 0   timeouts: 0   non-2xx: 0   → PASS (p95 246 ms ≤ 500 ms)
```

Post-run SQL integrity (§16 durable-delivery rows), scoped to the load
window (the shared dev DB also carries older e2e fixtures whose outbox rows
were cleaned by their suites):

- 0 duplicate `receipt_no`; 0 negative balances (0 oversells — no
  `INSUFFICIENT_STOCK` during the run);
- 19,865/19,865 run sales with **exactly one** outbox row each; sold units
  matched stock movements exactly (59,467 = 59,467 for the recording pass);
- after the worker drained the backlog (~1,200 events/min at the default
  batch/sweep settings): one `hq_sales` row per outlet sale — 19,865 rows,
  `SUM(total_minor)` = 55,440,000 on **both** databases, 0 duplicate
  `(outlet_id, source_sale_id)`.
