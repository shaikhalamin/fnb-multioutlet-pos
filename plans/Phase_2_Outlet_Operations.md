# Phase 2 — Outlet Operations (end-to-end: outlet-frontend → outlet-api → outlet PostgreSQL)
> **Historical record.** Two details changed in Phase 4: the JWT
> `outletId` claim is now pinned against the provisioned `outlet_identity`
> row (not env `OUTLET_ID`), and the seed is a no-op without identity env —
> production provisioning goes through the setup wizard (PRD FR-11).


## Context

Phase 0 delivered the outlet-backend scaffold (envelope/error plumbing, api/worker env profiles with `OUTLET_JWT_*` + HQ-key validation, migration CLI, worker entrypoint skeleton, health module) and the outlet-frontend shell (health page, axios envelope-unwrap, permission union). Phase 1 delivered the HQ stack and the patterns to mirror: JWT auth with rotating refresh sessions, RBAC guard, users module, Kubb pipeline, login + `_auth` layout.

Phase 2 per PRD §18: **outlet JWT/RBAC, catalog cache, inventory balances/movements, atomic multi-item sale, receipt counter, idempotent sale API, transactional outbox, and the local POS/inventory UI** — implemented end to end from the outlet React POS down to persisted DB rows, with verification at every layer.

**Scope decisions (confirmed by user):**
- **Include outlet local-user management** (`users` module with CRUD routes beyond §7.3, mirroring HQ Phase 1 precedent; Outlet Manager persona requires it).
- **Enforce the offline grace policy now** (PRD §8.8): sale creation blocks with `503 SYNC_TEMPORARILY_UNAVAILABLE` when `menu_sync_state.last_sync_at` is older than `OFFLINE_GRACE_HOURS` (default 72h). Seed writes a fresh timestamp so the demo works. The privileged emergency override is **deferred to Phase 3** (meaningful only once real sync exists).
- **Full PRD §11 outlet frontend set**: login, POS menu/cart/checkout with stable idempotency key, receipt confirmation/detail/reprint, inventory balances + audited adjustments, local sales history, sync-status banner.

**Implementation decisions (PRD-faithful, made during planning):**
- Catalog cache is **read-only in Phase 2**: seeded locally with fixed well-known item UUIDs to simulate a completed sync (revision + `last_sync_at` seeded). The Phase 3 pull worker/snapshot reconciles it; no fake HQ endpoints are built.
- `sync_attempt_logs` table is **deferred to the Phase 3 migration** (it audits delivery attempts, which don't exist yet). All other PRD §6.2 outlet tables land now.
- `stock_movements` gains a `request_id` column (FR-04 requires recording request ID; §6.2 lists "important fields" non-exhaustively).
- Sale `syncStatus` is resolved from the outbox row via a jsonb expression index `((payload->'data'->>'saleId'))` — §6.2 has no `sync_status` column on `sales`, and §8.7 keeps the concepts separate.
- `GET /menu` carries `meta.catalogRevision` / `meta.lastCatalogSyncAt` via a new `withMeta()` symbol hook in `EnvelopeInterceptor` (mirrors the existing `withCursor()`).
- Receipt format: `{prefix}-{zero-padded-6}` with prefix = `OUTLET_CODE` (e.g. `A-000001`), matching the sync-event v1 pattern `^[A-Za-z0-9_-]+-[0-9]{1,19}$`.
- Cookie: `outlet_rt`, `Path=/api/v1/auth`, HttpOnly, SameSite=Lax, Secure in prod.

**Out of scope (Phases 3–4):** BullMQ wiring and the outbox dispatcher/delivery workers, menu pull/snapshot sync, HQ sync-ingest endpoints, reconciliation, reporting, `sync_attempt_logs`, emergency override. Phase 2 writes outbox rows only; the worker entrypoint keeps its heartbeat.

**Commit policy (per user instruction):** every task below lands as exactly one commit with the stated message, only after its gates pass (`pnpm lint && pnpm test` on every backend/frontend task; `pnpm test:e2e` where DB-dependent; `pnpm lint && pnpm build && pnpm check` on frontend tasks). Backend tasks that add routes MUST re-run `pnpm openapi:export` and commit the regenerated `openapi/openapi.json` in the same commit (root AGENTS §3.5).

**Acceptance scenarios targeted:** AT-03, AT-04, AT-05, AT-06, AT-07, AT-08 (core), AT-17 outlet-flavor (persona permission denials), AT-11 partial (grace enforcement), AT-19 partial (price snapshots captured at sale time).

## Backend tasks (outlet-backend)

Existing scaffolding reused: `DATA_SOURCE` provider, `ApiException` + `GlobalExceptionFilter`, `EnvelopeInterceptor` (+`withCursor`), `makeGlobalValidationPipe()`, `JsonLogger` + ALS request context, env profiles (`OUTLET_JWT_*` on api profile, HQ key on worker profile, `OFFLINE_GRACE_HOURS` default 72), `src/contracts/sync-event-v1.schema.json`, migration CLI, `scripts/export-openapi.mjs`, `bearer-jwt` security scheme pre-registered in `src/openapi/document.ts`.

### T1 — Dependencies, entities, Phase-2 migration
> Commit: `feat(outlet-backend): add Phase 2 outlet schema and entities`

- Add deps mirroring hq-backend versions: `@nestjs/passport`, `passport`, `passport-jwt` + `@types/passport-jwt`, `@nestjs/jwt`, native `bcrypt` + `@types/bcrypt`, `cookie-parser` + `@types/cookie-parser`.
- Entities in `src/database/entities/` matching PRD §6.2 exactly (except `sync_attempt_logs`): `outlet_identity` (singleton), `outlet_users`, `outlet_roles`, `outlet_permissions`, `outlet_user_roles`, `outlet_role_permissions`, `outlet_refresh_sessions`, `catalog_items`, `menu_sync_state` (singleton), `inventory_balances`, `stock_movements` (+ `request_id`), `receipt_counters` (singleton), `sales`, `sale_items`, `sale_idempotency_keys`, `outbox_counters` (singleton), `outbox_events`. Money/sequence `bigint` (TS string), UUID PKs, snake_case columns. Register in `src/config/database.config.ts`.
- Migration `1720000000000-outlet-phase2-core.ts`: all tables + CHECKs from PRD §6.2 SQL block — `inventory_nonnegative`, sale-item positive/nonnegative checks, `receipt_counters.next_number > 0` — plus uniques `(outlet_id, key)` idempotency, `(outlet_id, receipt_number)`, `(outlet_id, receipt_no)`, `(sale_id, menu_item_id)`, `(outlet_id, sequence_no)` outbox, `uq_outlet_event_seq`, partial `idx_outbox_due`, `stock_movements(menu_item_id, occurred_at DESC)`, `sales(sold_at DESC)`, jsonb expression index `idx_outbox_sale_id ON outbox_events ((payload->'data'->>'saleId'))`, case-insensitive email unique.
- Register entities in the OpenAPI-export path (export script boots with inert env; verify `openapi:export` still works).
- Gates: `pnpm lint && pnpm test`; `pnpm migration:run` then `migration:revert` then `migration:run` against compose `outlet-a-db` (`127.0.0.1:15433`).

### T2 — common auth/RBAC + auth module
> Commit: `feat(outlet-backend): add outlet auth with rotating refresh sessions`

- `common/auth/`: `jwt.strategy.ts` (bearer, HS256 `OUTLET_JWT_ACCESS_SECRET`, pinned `OUTLET_JWT_ISSUER/AUDIENCE`, `validate()` reloads ACTIVE user + permissions from DB **and asserts claims `outletId === env OUTLET_ID`** — server-side identity, PRD §3), `jwt-refresh.strategy.ts` (cookie `outlet_rt`), `jwt-refresh.guard.ts`, `public.decorator.ts`, `current-user.decorator.ts`; wire `cookieParser` in `main.ts`.
- `common/rbac/`: `OUTLET_PERMISSIONS` catalog — `menu.read`, `sales.create`, `sales.read`, `inventory.read`, `inventory.adjust`, `sync.read`, `users.read`, `users.write` — `DEFAULT_OUTLET_ROLES`: `OUTLET_MANAGER` (all), `OUTLET_CASHIER` (`menu.read, sales.create, sales.read`), `OUTLET_INVENTORY_CLERK` (`menu.read, inventory.read, inventory.adjust`); `@RequirePermissions()` decorator + `JwtAuthGuard` as `APP_GUARD` (public skip → 401 `UNAUTHENTICATED` / 403 `FORBIDDEN`), mirroring `hq-backend/common/rbac/jwt-auth.guard.ts`.
- `modules/auth/`: `POST /auth/login` (`@Throttle` 5/min on top of global), `POST /auth/refresh` (cookie strategy, CAS rotation on `rotated_at`, reuse → revoke family + 401, AT-18 behavior), `POST /auth/logout`. `AuthUserResponse` includes `outletId` (PRD §9.1 login example). Separate access/refresh `JwtService` providers. Refresh cookie `outlet_rt` per decisions above.
- Unit specs: rotation CAS, reuse→family revoke, revoked/expired jti, inactive user, outletId-claim mismatch (mirror `hq-backend/src/modules/auth/auth.service.spec.ts`).
- Gates: lint/test + `pnpm openapi:export` (auth routes in the artifact).

### T3 — users module (local user management)
> Commit: `feat(outlet-backend): add local user management endpoints`

- `GET /users` (`users.read`, keyset cursor), `POST /users` (`users.write`: email, password→bcrypt, roleCodes), `PATCH /users/:id` (`users.write`: status, roleCodes), `GET /roles` (`users.read`). Duplicate email → 409; never serialize `passwordHash`. `CreateUserRequest`/`UpdateUserRequest`/`UserResponse`/`RoleResponse` with explicit `@ApiProperty`s.
- Gates: lint/test + unit spec (duplicate email, bcrypt hashing, role membership writes in one transaction) + `openapi:export`.

### T4 — menu-cache module (local catalog read model)
> Commit: `feat(outlet-backend): add local catalog cache menu endpoint`

- `MenuCacheRepository`: `findActiveItemsWithStock()` (catalog_items ⟕ inventory_balances; missing balance ⇒ 0), `getSyncState()` (singleton `menu_sync_state`: `last_applied_revision`, `last_sync_at`).
- `GET /menu` (`menu.read`): array of `OutletMenuItemResponse { menuItemId, sku, name, description, category, unitPriceMinor, currencyCode, availableQuantity }` with `meta.catalogRevision` + `meta.lastCatalogSyncAt` (PRD §7.3 example shape). Extend `EnvelopeInterceptor` with a `withMeta(payload, extra)` symbol hook (mirror `withCursor`), hoisted into `meta`.
- Gates: lint/test (interceptor meta spec) + `openapi:export`.

### T5 — inventory module
> Commit: `feat(outlet-backend): add inventory balances and audited adjustments`

- `GET /inventory` (`inventory.read`): `InventoryBalanceResponse[]` (menuItemId, name, sku, quantityOnHand, version, updatedAt).
- `POST /inventory/adjustments` (`inventory.adjust`): `AdjustInventoryRequest { menuItemId: UUID, deltaQuantity: nonzero int bounded ±1_000_000, reason: RESTOCK|WRITE_OFF|RECOUNT }` → one transaction: lock balance row `FOR UPDATE`, assert resulting ≥ 0 (else 422), update balance `version++`, append `stock_movements` row (`reason`, `actor_id`, `request_id` from `X-Request-Id`). Item must exist in local catalog → 422 otherwise.
- Gates: lint/test + `openapi:export`.

### T6 — receipts + outbox repositories (sale-transaction support)
> Commit: `feat(outlet-backend): add receipt counter and outbox repositories`

- `modules/receipts/`: `ReceiptCounterRepository` — `allocate(manager)` locks the singleton row `FOR UPDATE`, increments `next_number`, returns `{ receiptNumber, receiptNo }` with `formatReceiptNo(prefix, n)` = `{prefix}-{String(n).padStart(6,"0")}`.
- `modules/outbox/`: `OutboxRepository` — `allocateSequence(manager)` locks `outbox_counters` `FOR UPDATE` and increments; `insertSaleCompletedEvent(manager, event)` builds the `sale.completed` payload exactly per `src/contracts/sync-event-v1.schema.json` (eventId = outbox row UUID, `payload_sha256` over canonical JSON), inserts status `PENDING`; `findStatusBySaleId(saleId)` via the jsonb expression index; `countByStatus()` + `oldestPendingAt()` for sync status.
- Unit specs for receipt formatting, payload invariants (`quantity × unitPrice = subtotal`, `sum(subtotal) = total`), canonical-JSON hashing.
- Gates: lint/test.

### T7 — sales module (the protected core, PRD §8.6)
> Commit: `feat(outlet-backend): add atomic idempotent multi-item sales`

- `POST /sales` (`sales.create`, requires `Idempotency-Key` header — missing ⇒ 400 `VALIDATION_FAILED`). `CreateSaleRequest { items: SaleItemLineRequest[{ menuItemId: UUID, quantity: int 1..100_000 }] }`, `@ArrayMinSize(1) @ArrayMaxSize(100)`. Client price/total/receipt/outletId fields are rejected by the global whitelist pipe by construction.
- One `QueryRunner` transaction in exact §8.6 order: (1) guard already validated user/permission; (2) **merge duplicate lines by `menuItemId`** (sum quantities) then canonicalize + SHA-256 hash with the idempotency key; (3) insert/lock `sale_idempotency_keys` — existing row with same hash ⇒ return stored `response_json` replay (same sale/receipt, AT-07); same key + different hash ⇒ 409 `IDEMPOTENCY_KEY_REUSED` (AT-08); (4) **offline grace check**: `menu_sync_state.last_sync_at` older than `OFFLINE_GRACE_HOURS` ⇒ 503 `SYNC_TEMPORARILY_UNAVAILABLE` (details `lastMenuSyncAt`, `offlineGraceHours`); (5) load active `catalog_items` (unassigned/inactive ⇒ 422 `ITEM_NOT_ASSIGNED`/`ITEM_INACTIVE`); (6) atomic conditional stock updates `UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand - $q, version = version + 1 WHERE menu_item_id = $id AND quantity_on_hand >= $q RETURNING …` in **sorted menuItemId order** — no row ⇒ rollback + 409 `INSUFFICIENT_STOCK` with `{menuItemId, requestedQuantity, availableQuantity}` (AT-04); (7) insert `stock_movements` per line (`source_sale_id`, actor); (8) `ReceiptCounterRepository.allocate`; (9) insert `sales` + `sale_items` with immutable name/SKU/unit-price/currency/`catalog_revision` snapshots (AT-19 partial), all math in `BigInt`; (10) `OutboxRepository.allocateSequence` + `insertSaleCompletedEvent` (AT-03: exactly one outbox row per sale); (11) persist idempotency response JSON; (12) COMMIT. Any error rolls back everything; **no BullMQ/queue calls inside the transaction**.
- `GET /sales/:id` (`sales.read`): full `SaleResponse` incl. `syncStatus` resolved from the outbox row. `GET /sales?from=&to=&cursor=` (`sales.read`): keyset pagination `(sold_at, id)`, `SaleSummaryResponse[]` + `meta.nextCursor`. `soldAt`, totals, receipt, outlet identity are always server-computed (root AGENTS §5).
- Unit specs: line merging, bigint totals, idempotent replay vs key-reuse, insufficient-stock details payload, grace expiry, inactive/unassigned item rejection.
- Gates: lint/test + e2e happy path (AT-03: 2 burgers + 1 pizza ⇒ totals `"3900"`-style math, 2 movements, receipt `A-000001`, 1 outbox PENDING event) + `openapi:export`.

### T8 — sync module (local status endpoint)
> Commit: `feat(outlet-backend): add local sync status endpoint`

- `GET /sync/status` (`sync.read`): `SyncStatusResponse { outletId, outletCode, lastAppliedRevision (decimal string), lastMenuSyncAt, grace: { hours, expiresAt, expired }, outbox: { pendingCount, quarantinedCount, oldestPendingAt, lastPublishedAt } }` — all read from local tables (menu_sync_state + outbox); no HQ calls (an outlet sale/status never depends on HQ).
- Gates: lint/test + `openapi:export`.

### T9 — seed script
> Commit: `feat(outlet-backend): add outlet seed — identity, users, catalog, inventory, counters`

- `src/database/seed.ts` + `pnpm seed` + real `scripts/seed.sh` (replace Phase-0 placeholder); idempotent, natural-key based: `outlet_identity` from `OUTLET_ID`/`OUTLET_CODE` env (+ `SEED_OUTLET_TIMEZONE` default `UTC`, currency USD); permission catalog + 3 roles + memberships from `DEFAULT_OUTLET_ROLES`; demo users (dev defaults with warn): `manager@outlet-a.local`/`Manager123!`, `cashier@outlet-a.local`/`Cashier123!`, `clerk@outlet-a.local`/`Clerk123!` (overridable via `SEED_OUTLET_*_EMAIL/PASSWORD`); demo catalog with **fixed UUIDs** (BURGER-01 `"1000"`, PIZZA-01 `"1500"`, COLA-01 `"300"`, USD, `applied_revision = 1`); `menu_sync_state` with `last_sync_at = now()`; inventory balances (burger 50, pizza 40, cola 100); `receipt_counters` (prefix = `OUTLET_CODE`, `next_number = 1`); `outbox_counters` (`next_sequence = 1`).
- Gates: lint/test; run seed twice against compose DB ⇒ no duplicates.

### T10 — concurrency & idempotency e2e suites
> Commit: `test(outlet-backend): verify sale atomicity, concurrency, and idempotency`

- New e2e specs in `test/` against real Postgres/Redis (`outlet-a-db` `127.0.0.1:15433`, `outlet-a-redis` `16380`; self-skip without env, mirroring Phase-1 helpers):
  - **AT-05**: two parallel sales of the last unit ⇒ exactly one 201, one 409, stock ≥ 0.
  - **AT-06**: 100 concurrent sales ⇒ 100 distinct sequential receipts, zero duplicates.
  - **AT-04**: multi-item sale with one short line ⇒ zero sale/movement/counter/outbox side effects (SQL asserts).
  - **AT-07/AT-08**: same key replay returns identical stored response (no second deduction/event); same key + mutated body ⇒ 409 and original sale unchanged.
  - Grace expiry: backdate `menu_sync_state.last_sync_at` 73h ⇒ 503 `SYNC_TEMPORARILY_UNAVAILABLE`; persona denials (AT-17 flavor): cashier ⇒ 403 on `POST /inventory/adjustments`, clerk ⇒ 403 on `POST /sales`; auth e2e (login, rotation, reuse ⇒ family revoked).
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` all green.

## Frontend tasks (outlet-frontend)

Existing: TanStack Start SPA shell, `src/api/axios.ts` (envelope unwrap, `X-Request-Id`), `lib/permissions.ts` union (extend with `users.read/write`), shadcn-style `components/ui`, Tailwind v4. Pattern reference: hq-frontend Phase 1.

### T11 — Kubb pipeline + auth-aware axios layer + build gate fix
> Commit: `feat(outlet-frontend): generate typed API client and wire auth-aware axios layer`

- Copy `outlet-backend/openapi/openapi.json` → `src/api/contracts/outlet.openapi.json`; pinned `kubb.config.ts` mirroring hq-frontend (pluginTs/pluginZod/pluginAxios `returnType: 'data'` `baseURL: '/api/v1'`/pluginReactQuery) + `pnpm generate:api`; output `src/api/generated/` (never hand-edited).
- Rework `axios.ts` onto the generated runtime instance: `Authorization` bearer from in-memory `src/features/auth/session.ts`, single-flight refresh-and-retry on 401 via `fetch('/api/v1/auth/refresh')` (skip login/refresh routes), failure ⇒ clear session ⇒ `/login`; drop the hand-written `apiGet`/`types/api.ts` health typing in favor of generated client.
- **Fix the build gate (root AGENTS §6)**: `pnpm build` becomes `tsc --noEmit && vite build`; add vite dev proxy `/api` → `OUTLET_API_PROXY_TARGET ?? http://localhost:5000`.
- Money: add pure string-math `formatMinor` to `lib/utils.ts` (mirror hq-frontend; never `Number(minor)`).
- Gates: `pnpm generate:api` clean, `pnpm lint && pnpm build && pnpm check`.

### T12 — Login + protected shell
> Commit: `feat(outlet-frontend): add login and protected app shell`

- `/login` (Zod form, `error.code`-driven messages), session bootstrap via silent refresh, `_auth` protected layout with permission-gated nav (POS, Inventory, Sales, Users for managers), header user menu + logout — mirror hq-frontend `routes/login.tsx` / `routes/_auth.tsx`. Auth-session payloads parsed with generated Zod schemas (root AGENTS §4.2).
- Gates: lint/build/check.

### T13 — POS feature (menu, cart, checkout)
> Commit: `feat(outlet-frontend): add POS checkout with stable idempotency key`

- `features/pos`: menu grid from `GET /menu` (price via `formatMinor`, live `availableQuantity`), cart with quantity steppers, checkout flow: **mint one `Idempotency-Key` per sale attempt, held in component/session state and reused across retries/timeouts until response or abandonment — never a second key for the same attempt** (root AGENTS §4.4, AT-07/AT-08); payload is only `items: [{menuItemId, quantity}]`; totals/receipt render exclusively from the authoritative `SaleResponse`; **no optimistic stock/money updates**; post-checkout receipt confirmation panel with print button.
- Parse `GET /menu` and `POST /sales` responses with generated Zod schemas in the `queryFn` (money-bearing payloads).
- Gates: lint/build/check.

### T14 — Inventory feature
> Commit: `feat(outlet-frontend): add inventory balances and audited adjustments`

- `features/inventory`: balances table (item, SKU, on-hand, updated), adjustment dialog (RESTOCK/WRITE_OFF/RECOUNT + signed quantity, inline validation, `INSUFFICIENT_STOCK`-style error surfacing via `ApiError`), `inventoryKeys` factories, manager+clerk nav visibility.
- Gates: lint/build/check.

### T15 — Sales history + receipt detail + sync banner
> Commit: `feat(outlet-frontend): add sales history, receipt detail, and sync-status banner`

- `features/sales`: date-filtered history (`from/to` via Zod-validated `validateSearch`, cursor pagination) → receipt detail view (`GET /sales/:id`) with reprint (`window.print`).
- `features/sync-status`: banner polling `GET /sync/status` (30s) — "Menu rev X · synced <time>", pending-upload count, escalating warning when grace `expiresAt` near/past. **Never blocks a local sale.**
- `features/users` (managers): list/create/edit local users — the T3 endpoints.
- Gates: lint/build/check.

## T16 — End-to-end verification + docs
> Commit: `docs: document Phase 2 outlet operations and verification`

1. `docker compose up -d outlet-a-db outlet-a-redis` → `pnpm migration:run` + `pnpm seed` against `127.0.0.1:15433`; full backend suite green.
2. `docker compose up -d` (outlet-a stack; `outlet-a-migrate` runs the migration) → `pnpm seed` in the api container (or documented host command).
3. Browser walkthrough at `http://localhost:8081` (browser-use): login as cashier → POS: 2× burger + 1× pizza → checkout ⇒ receipt `A-000001` with server totals; stock visibly decremented (fresh `GET /menu`); retry a timed-out checkout with the same key ⇒ same receipt (AT-07); clerk login → restock burger +50 with reason; manager login → create a new cashier, sync banner shows 1 pending upload from the sale.
4. SQL via `docker exec outlet-a-db psql`: sale + 2 sale_items with snapshot prices; 3 stock_movements; receipt counter advanced once; outbox row PENDING with `payload_sha256`; idempotency row with `response_json`; balances nonnegative.
5. curl spot-checks: 401 without token; 403 cashier-on-adjustment; 409 `INSUFFICIENT_STOCK` details shape; 409 `IDEMPOTENCY_KEY_REUSED`; 503 grace expiry after backdating `last_sync_at`; envelope + `X-Request-Id` everywhere.
6. Update root `README.md` (Phase 2 section, seeded credentials, verification results) and both outlet READMEs.

## Definition of done (Phase 2)

- AT-03…AT-08 pass (e2e + concurrency suites); AT-17-flavor persona denials pass; grace enforcement demonstrated (AT-11 partial); sale snapshots preserve historical prices (AT-19 partial).
- `openapi:export` artifact and outlet-frontend generated client are current (`generate:api` is a no-op diff); `pnpm build` type-checks on both frontends' rule (outlet-frontend fixed in T11).
- No secrets in frontend bundles; sale transaction contains zero queue/HTTP calls; every money value is a decimal string end to end.
