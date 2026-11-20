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
