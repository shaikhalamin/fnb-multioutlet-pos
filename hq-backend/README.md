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
