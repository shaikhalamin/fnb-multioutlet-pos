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
