# Phase 1 — HQ Security & Catalog (end-to-end: hq-frontend → hq-api → PostgreSQL)

## Context

Phase 0 delivered the four-app scaffold (envelope/error plumbing, env profiles, compose stack, OpenAPI export, health modules). Phase 1 per PRD §18: **HQ JWT + rotating refresh, HQ users/RBAC, outlets, master menu CRUD, assignments & prices, outlet key issuance/rotation, per-outlet catalog revisions and changes** — implemented end to end from the HQ React UI down to persisted DB rows, with verification at every layer.

**Scope decisions (confirmed by user):**
- **MFA is dropped entirely from the product** — not built, not deferred — and removed from all PRD/AGENTS docs (T0).
- Add `/categories` CRUD (FR-01 requires it; §7.2 table is incomplete).
- Full user management: seed super admin **plus** user CRUD endpoints **and** hq-frontend UI (beyond §7.2, per user request).
- Full verification: e2e tests against real Postgres/Redis + browser walkthrough + SQL inspection; demo seed (outlets A/B/C, burger/pizza/cola) for AT-01/AT-02-style checks.

**Out of scope (Phases 2–4):** outlet-backend changes, `/sync/v1/*` endpoints, sales/inventory, reporting. `hq-worker` keeps its heartbeat; catalog fan-out is synchronous inside admin transactions (§8.2 rules 1–3), so no queue work is needed.

## T0 — Remove MFA from all documentation

Edit exactly these five files (verified by grep, the only MFA/multi-factor mentions in the repo):

| File | Location | Edit |
|---|---|---|
| `fnb_multi_outlet_prd.md` | §9.1 (~line 857) | Delete trailing sentence "MFA for HQ admins is strongly recommended." |
| `fnb_multi_outlet_prd.md` | §11 (~line 942) | "**HQ frontend:** login/MFA; dashboard" → "**HQ frontend:** login; dashboard" |
| `hq-backend/prd.md` | §9.1 (~line 293) | Delete trailing "MFA for HQ admins is strongly recommended." |
| `hq-frontend/prd.md` | §3 item 1 (~line 32) | "email/password sign-in; ~~MFA support… strongly recommended~~. Handles…" → keep email/password + refresh/logout wording only |
| `hq-frontend/prd.md` | §11 Phase 1 (~line 151) | "login (+MFA recommended)" → "login" |
| `hq-frontend/AGENTS.md` | Mission (~line 8) | "login/MFA, dashboard" → "login, dashboard" |

## Backend tasks (hq-backend)

**Existing scaffolding reused:** custom `DATA_SOURCE` provider (`src/database/database.module.ts`), `ApiException` + `GlobalExceptionFilter`, `EnvelopeInterceptor`, `makeGlobalValidationPipe()`, `JsonLogger`, env profiles in `src/config/env.schema.ts` (already requires `HQ_JWT_*`, `OUTLET_KEY_PEPPER` on the API profile), OpenAPI security schemes (`bearer-jwt`, `outlet-key`) in `src/openapi/document.ts`, `scripts/export-openapi.mjs`, migration CLI (`src/database/migrate.ts`).

### T1 — Dependencies, entities, Phase-1 migration, seed
- Add deps (revised to the Passport stack): `@nestjs/passport`, `passport`, `passport-jwt` + `@types/passport-jwt`, `@nestjs/jwt`, native `bcrypt` + `@types/bcrypt` (ships musl prebuilds, so Alpine needs no build tooling).
- Entities in `src/database/entities/` matching PRD §6.1 exactly: `companies`, `outlets`, `hq_users`, `hq_roles`, `hq_permissions`, `hq_user_roles`, `hq_role_permissions`, `hq_refresh_sessions`, `menu_categories`, `master_menu_items`, `outlet_menu_assignments`, `outlet_catalog_revisions`, `outlet_catalog_changes`, `outlet_api_keys`, `audit_logs`. Money columns `bigint` (TypeORM returns strings — serialize as-is). Register entities in `src/config/database.config.ts`.
- Migration `1710000000000-hq-phase1-core.ts`: all tables + CHECKs (`price >= 0`), uniques (`(company_id, sku)`, `(outlet_id, menu_item_id)`, `(outlet_id, revision)`, lower-email), `idx_catalog_changes_cursor`, `master_menu_items(company_id,status,category_id)`, `outlet_menu_assignments(outlet_id,active)`.
- `src/database/seed.ts` + `pnpm seed` + `scripts/seed.sh` (idempotent): company, permission catalog (`menu.read/write, outlets.read/write, assignments.read/write, keys.manage, users.read/write, reports.read, sync.read`), roles (HQ_SUPER_ADMIN all, HQ_MENU_MANAGER menu/assignments, HQ_ANALYST reports+sync read), super admin (`SEED_HQ_ADMIN_EMAIL/PASSWORD`, dev defaults), demo outlets A/B/C + categories (Burgers/Pizza/Drinks) + items (BURGER-01 "1000", PIZZA-01 "1500", COLA-01 "300", USD).
- Generate two independent dev HS256 secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `openssl rand -base64 48`) + random pepper into gitignored root `.env`/`.env.local`.

### T2 — common auth/RBAC + auth module
- `common/auth/` (revised): `jwt.strategy.ts` (Passport bearer strategy, HS256 `JWT_ACCESS_SECRET`, iss/aud/exp; `validate()` reloads ACTIVE user + permissions from DB), `jwt-refresh.strategy.ts` (cookie-extracting strategy, HS256 `JWT_REFRESH_SECRET`), `jwt-refresh.guard.ts`, `public.decorator.ts`, `current-user.decorator.ts`. Two per-purpose `@nestjs/jwt` `JwtService` providers (access/refresh) in `auth.providers.ts`.
- `common/rbac/`: permission constants, `@RequirePermissions('menu.write')` decorator, `JwtAuthGuard extends AuthGuard('jwt')` as `APP_GUARD` — public skip → Passport verifies the bearer JWT (strategy reloads ACTIVE user + permissions from DB, PRD §9.1 recheck) → 401 `UNAUTHENTICATED` / 403 `FORBIDDEN`.
- `modules/auth`: `POST /auth/login` (rate-limited via `@nestjs/throttler`: global `ThrottlerGuard` at 100 req/min in `AppModule` + `@Throttle` 5 req/min on the route), `POST /auth/refresh` (guarded by the `jwt-refresh` cookie strategy), `POST /auth/logout`. Refresh tokens are signed JWTs (own secret) whose `jti` is tracked server-side in `hq_refresh_sessions`; rotation via CAS on `rotated_at` inserts a successor row (new `jti`) in the same `family_id`; old-`jti` reuse → revoke family + audit + 401 (AT-18 behavior). Cookie `hq_rt`: HttpOnly, SameSite=Lax, Secure in prod, `Path=/api/v1/auth`. Login/refresh responses: `{ accessToken, tokenType, expiresInSeconds, user: { id, email, roleCodes, permissions } }` (PRD §9.1; refresh token never in JSON).
- `modules/audit` (service only): `AuditService.record(...)` for login/logout/reuse/key/user events.

### T3 — users module
- `GET /roles` (users.read); `GET /users` (users.read, cursor pagination); `POST /users` (users.write: email, password→bcrypt, roleCodes); `PATCH /users/:id` (users.write: status, roleCodes). Never serialize `passwordHash`. Duplicate email → 409.

### T4 — outlets module
- `GET /outlets` (outlets.read), `POST /outlets` (outlets.write: code, name, timezone) — same transaction inserts the locked `outlet_catalog_revisions` row (revision 0).

### T5 — menu module (categories + master items)
- Categories: `GET/POST /categories`, `GET/PATCH /categories/:id` (archive via status; no hard delete).
- Items: `GET/POST /menu-items` (filters: categoryId, status, q; cursor), `GET/PATCH /menu-items/:id` — SKU immutable, `version++`, archive = status `ARCHIVED` tombstone.
- Shared `CatalogChangesService.appendChanges(tx, outletIds, payload)`: locks each `outlet_catalog_revisions` row `FOR UPDATE`, increments, appends `outlet_catalog_changes`. Item update → UPSERT change (full §8.3 snapshot: assignmentId, sku, name, description, category, unitPriceMinor, currencyCode, active, itemVersion) to every outlet with an active assignment; archive → REMOVE change. All inside the admin mutation transaction (§8.2 — never commit a menu change without its distribution record).

### T6 — assignments module
- `PUT /outlets/:outletId/menu/:itemId` (`AssignMenuRequest { active, priceOverrideMinor? }`) — atomic upsert + UPSERT/REMOVE change; response carries `defaultPriceMinor`, `priceOverrideMinor`, `effectivePriceMinor`, `catalogRevision` (PRD §7.2 example).
- `DELETE /outlets/:outletId/menu/:itemId` — soft-unassign + REMOVE revision.
- `GET /outlets/:outletId/menu` (assignments.read) → `OutletMenuResponse` rows for the matrix UI.
- Money: `^\d+$` DTO validation + `BigInt` in service; effective price = override ?? default.

### T7 — api-keys module
- `POST /outlets/:outletId/api-keys` (keys.manage): `keyId` + 256-bit secret, **shown exactly once** in the create response; stores HMAC-SHA256(`OUTLET_KEY_PEPPER`, secret), scopes `menu.pull|events.push|status.write`, constant-time compare helper (consumed by Phase 3 guard).
- `GET /outlets/:outletId/api-keys` (list — never secrets), `POST .../:keyId/rotate` (new key `rotated_from_id`; old key keeps bounded overlap expiry — `KEY_ROTATION_GRACE_HOURS` env, default 24), `DELETE .../:keyId` (REVOKED). Audit rows for all three.

### T8 — Backend contract + quality gates
- Every guarded route: `@ApiTags/@ApiOperation/@ApiOkResponse/@ApiResponse/@ApiSecurity('bearer-jwt')`, explicit `@ApiProperty` DTOs (`CreateMenuItemRequest`, `MenuItemResponse`, `AssignmentResponse`, `IssueOutletKeyResponse`, …) — then `pnpm openapi:export`.
- `pnpm lint`, `pnpm test`, `pnpm test:e2e` with real Postgres/Redis from compose (published ports 15432/16379). New e2e specs in `test/`: auth (login, rotation, **AT-18** reuse → family revoked), RBAC (Analyst → 403 on menu.write, **AT-17 flavor**), users, outlets, menu + fan-out, assignments (**AT-01**: changes exist for A/B not C; **AT-02**: override 1200 vs default 1000), api-keys (hash-not-plaintext via SQL).

## Frontend tasks (hq-frontend)

Existing: TanStack Start SPA, `src/api/axios.ts` shared instance, `lib/permissions.ts`, `components/ui` (shadcn-style), Tailwind v4.

### T9 — Kubb pipeline + session wiring
- Copy `hq-backend/openapi/openapi.json` → `src/api/contracts/hq.openapi.json`; add pinned `kubb.config.ts` (`@kubb/plugin-ts`, `plugin-zod`, `plugin-client/axios` bound to the shared axios instance, `plugin-tanstack-query`) + `pnpm generate:api` script; generated output `src/api/generated/` (never hand-edited).
- Rework `axios.ts` unwrap so `response.data` becomes the bare payload (meta stashed aside) — generated clients then see DTO types directly; attach `Authorization` from the in-memory session; single-flight refresh-and-retry on 401 (never for `/auth/login|refresh`); failure → clear session → `/login`. `src/features/auth/session.ts` in-memory token store. Add vite dev proxy `/api` → `localhost:4000`.

### T10 — Login + protected shell
- `/login` (Zod form, `error.code` messages), session bootstrap via refresh on load, protected layout with permission-gated nav (cosmetic only — backend enforces), header user menu + logout; dashboard gets an outlets overview + quick links.

### T11 — Menu UI
- `features/menu`: categories CRUD; items table with create/edit dialogs, archive, money formatter (`formatMinor` in `lib/utils`), `menuKeys` factories, Zod parsing.

### T12 — Outlets + assignment matrix + keys UI
- `features/outlets`: list + create (code/name/timezone).
- `features/assignments`: outlet selector → per-outlet table of items with assign toggle, override editor showing **live effectivePrice preview** (FR-02), catalog revision badge; PUT/DELETE mutations.
- `features/api-keys` (outlet page): issue → one-time secret dialog (copy button, never logged/stored), rotate, revoke, key list with status/lastUsedAt.

### T13 — Users UI + frontend gates
- `features/users`: list, create (email/password/roles), status & role editing. `pnpm lint && pnpm build && pnpm check`.

## T14 — End-to-end verification (user request → DB persistence)

1. Real dev keys in root `.env`; `docker compose up -d hq-db hq-redis`; run all backend suites against them.
2. `docker compose up -d` (HQ stack; hq-migrate runs the Phase-1 migration automatically) → `pnpm seed` against `127.0.0.1:15432`.
3. Browser walkthrough at `http://localhost:8080` (browser-use): login as seeded admin → create category + item → assign burger to Outlet B with `"1200"` override (preview shows $12.00) → confirm Outlet A shows default $10.00 and C nothing (AT-01/AT-02 data) → issue API key (secret shown once) → create HQ Menu Manager user → login as that user (menu allowed, users/keys forbidden).
4. SQL via `docker exec hq-db psql`: `outlet_catalog_revisions.current_revision` increments; `outlet_catalog_changes` UPSERT/REMOVE payloads with contiguous per-outlet revisions and no rows for outlet C; `outlet_api_keys.secret_hash` = HMAC (≠ plaintext); `hq_refresh_sessions` family rows/revocations; `audit_logs` rows; `master_menu_items.default_price_minor` stored as bigint.
5. curl spot-checks: 401 without token, 403 Analyst-on-menu-write, envelope + `X-Request-Id` on every response.
6. Update the three READMEs with Phase-1 run/verify instructions.

No git commits unless you ask; each task lands as a coherent unit with tests green before moving to the next.