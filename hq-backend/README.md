# hq-backend

Headquarters NestJS application (API + worker entrypoints) for the
multi-outlet F&B platform — see the root
[PRD](../fnb_multi_outlet_prd.md) for the full architecture.

HQ owns the master menu, outlet assignments and price overrides, outlet API
keys, sync ingestion and cross-outlet reporting. It never connects to an
outlet database; all synchronization is outlet-initiated.

## Entrypoints

| Entry | File | Purpose |
|---|---|---|
| API | `src/main.ts` | HTTP API under `/api/v1` (auth, users, outlets, menu, assignments, keys, health, docs) |
| Worker | `src/worker-main.ts` | Background processors without HTTP (queues land in Phase 3) |
| Migrations | `src/database/migrate.ts` | `run` / `revert` / `show` via `scripts/migrate.sh` |
| Seed | `src/database/seed.ts` | Idempotent bootstrap: company, permissions, roles, super admin, demo catalog |

## Commands (pnpm via corepack)

```bash
corepack enable
cp .env.example .env   # host-side runs only; Compose injects its own values
pnpm install
pnpm start:dev        # dev server (loads .env if present)
pnpm build && pnpm start:prod
pnpm start:worker
pnpm lint && pnpm test
pnpm test:e2e         # needs real DATABASE_URL + REDIS_URL (loads .env.local gaps)
pnpm migration:run    # apply migrations (tsx locally; dist in images)
pnpm seed             # idempotent seed (SEED_HQ_ADMIN_EMAIL / SEED_HQ_ADMIN_PASSWORD)
pnpm openapi:export   # regenerate openapi/openapi.json after endpoint changes
```

`.env` is only read by processes started from this folder; the Docker flow
never sees it. Its `DATABASE_URL`/`REDIS_URL` target the root Compose
datastores published on loopback (`localhost:15432` / `16379`), so bring
those up first from the repo root (`docker compose up -d hq-db hq-redis` —
see the root README quickstart). `OUTLET_KEY_PEPPER` must equal the root
`.env` value `hq-api` runs with (the Compose seed run guarantees that match);
the pepper hashes every outlet machine key issued via the console (PRD §9.2).

## Configuration

Config parse → Zod validation → module → typed access (PRD §14.1):

- `src/config/env.schema.ts` — the Zod schema and `Env` type, plus
  entrypoint profiles: the **api** profile requires `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `HQ_JWT_ISSUER`/`HQ_JWT_AUDIENCE` and
  `OUTLET_KEY_PEPPER`; the **worker** profile requires nothing beyond the
  base schema (the worker never issues human JWTs — PRD §3).
- `src/config/configuration.module.ts` — global `ConfigurationModule`
  (`ConfigModule.forRoot` with `isGlobal`, `cache`, the Zod `validate` hook
  and `envFilePath: ['.env.local', '.env']`; real environment variables
  always win).
- Typed access everywhere via `ConfigService<Env, true>` with
  `config.get('KEY', { infer: true })` (see `DatabaseModule` and the health
  Redis provider).

Missing or inconsistent values (e.g. `REFRESH_TOKEN_TTL <= ACCESS_TOKEN_TTL`)
fail startup with a structured fatal log. See [.env.example](./.env.example)
for the full list; placeholder-only, never commit secrets.

## Phase 0 foundation

- **Envelope contract** — every response is `ApiSuccess { data, meta.requestId }`
  or `ApiError { error.code, requestId }` (PRD §7.1); errors use stable codes
  from PRD §12.
- **Request IDs** — `X-Request-Id` honored/generated per request and carried
  into structured JSON logs via AsyncLocalStorage (PRD §13).
- **Logging** — one JSON object per line (`time`, `level`, `service`,
  `context`, `requestId`, `msg`); compact human format in development.
- **Health** — `GET /api/v1/health` probes PostgreSQL and Redis and returns
  `503 SERVICE_UNAVAILABLE` with per-dependency detail when degraded.
- **Migrations** — TypeORM data source with `synchronize: false`; compose runs
  the single controlled `hq-migrate` job before the API starts (PRD §14.2).
- **OpenAPI** — Swagger UI at `/api/v1/docs` + `/openapi.json` when
  `SWAGGER_ENABLED=true`; committed artifact in `openapi/openapi.json` is the
  source for the `hq-frontend` Kubb pipeline (PRD §11).
- **Sync contract** — versioned outlet-event JSON Schema in
  `src/contracts/sync-event-v1.schema.json` (PRD §8.4), identical to the
  outlet-backend copy.

## Phase 3 — sync ingestion surface (PRD §7.4, §8.5–§8.7)

Machine-key routes under `/sync/v1/*` (`Authorization: OutletKey
<keyId>.<secret>`, scopes `menu.pull` / `events.push` / `status.write`,
600/min throttle, no CORS ever — §9.2):

- `GET /sync/v1/menu/changes?afterRevision=&limit=` — ascending per-outlet
  deltas; `snapshotRequired` on truncation/gaps (AT-14).
- `GET /sync/v1/menu/snapshot` — one REPEATABLE READ view: `snapshotId`,
  `snapshotRevision`, full effective items incl. tombstones.
- `POST /sync/v1/events/batch` — per-event transactions: inbox dedupe
  (`(outletId,eventId)` / `(outletId,sequenceNo)` + canonical payload hash),
  immutable `hq_sales`/`hq_sale_items` projections, contiguous-only
  checkpoint advance (AT-21). Mixed outcomes ride one HTTP 200.
- `GET /sync/v1/checkpoint` + `POST /sync/v1/heartbeat` — reconciliation
  input and outlet backlog reporting (`sync_outlet_checkpoints`).
- `GET /outlets/:id/sync-status` — human projection (FR-10, `sync.read`).

Identity comes exclusively from the key record; events claiming another
outlet reject the entire request (AT-16). Keys are issued in the console
only — the seed never mints one; the outlet terminal pairs itself through
its `/setup` wizard (see root README §"Machine-key provisioning").

## Phase 4 — reporting, audit & hardening (PRD §10, §11, §18)

- `GET /reports/revenue-by-outlet?from=&to=&currency=` (`reports.read`) —
  SQL `bigint` sums over `hq_sales` only (never outlet DBs, FR-08);
  **every ACTIVE outlet appears** with zero rows as `"0"` + null
  `lastIngestedAt` (a missing contribution is disclosed, never "no sales").
- `GET /reports/outlets/:id/top-items?from=&to=&limit≤5` (`reports.read`) —
  `quantitySold DESC, menu_item_id` tie-break; master-name join with
  sale-time snapshot fallback (AT-19). Unknown outlet → 404.
- Staleness contract (AT-20): `dataAsOf` = global max `ingested_at`;
  `isProvisional` = any ACTIVE outlet with a reported outbox backlog or no
  ingested sale. Windows are UTC-only, `from` inclusive / `to` exclusive,
  span ≤ 366 days (§15).
- `GET /audit/logs` (new **`audit.read`** permission, HQ_SUPER_ADMIN only) —
  immutable newest-first listing, action/actor/entity/`occurred_at` filters,
  deterministic `(occurred_at, id)` cursor via `meta.nextCursor`.
  **Existing databases must re-seed once:** `pnpm seed` (idempotent — adds
  the permission and its role mapping).
- Worker (`pnpm start:worker`): BullMQ-free; audit retention is an hourly
  interval timer over `AUDIT_LOG_RETENTION_DAYS` (default `0` = disabled —
  the trail is immutable out of the box), deleting ≤1000-row batches with a
  structured `{deleted, cutoff}` summary.
- E2e (`pnpm test:e2e`, real PostgreSQL + Redis): `reporting.e2e-spec.ts`
  (exact decimal-string totals incl. >2^53 fixtures, window boundaries,
  isProvisional flip on heartbeats, top-items isolation/tie-break),
  `audit.e2e-spec.ts` (auth-event visibility, filters, cursor walk, analyst
  403), `security.e2e-spec.ts` (AT-17 forged-token matrix + §9.3 walk +
  human/machine credential crossover).
