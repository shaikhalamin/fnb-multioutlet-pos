# AGENTS.md — fnb-platform Engineering Guidelines

Strict, enforceable rules for every agent (human or AI) working in this repository.
The single source of truth is [fnb_multi_outlet_prd.md](./fnb_multi_outlet_prd.md) ("the PRD").
Where this file and the PRD disagree, the PRD wins; fix this file.

Each application additionally has its own `AGENTS.md` with project-specific rules:

| Application | Folder | Read before touching |
|---|---|---|
| HQ backend (API + worker) | `hq-backend/` | `hq-backend/AGENTS.md` |
| Outlet backend (API + sync worker) | `outlet-backend/` | `outlet-backend/AGENTS.md` |
| HQ frontend | `hq-frontend/` | `hq-frontend/AGENTS.md` |
| Outlet POS frontend | `outlet-frontend/` | `outlet-frontend/AGENTS.md` |

---

## 1. Non-negotiable architecture boundaries (PRD §1, §2)

1. Exactly **four independently built and deployed apps**. Never merge them into a shared build, shared Nest app, or shared Express server.
2. **Sync is outbound-only from outlet to HQ.** The outlet worker *pulls* menu changes and *pushes* events over HTTPS. HQ never connects to, queries, or writes an outlet database (PRD §1.3, §8.1).
3. **An outlet sale must never depend on an HQ request.** No outlet business transaction may make a synchronous HTTP call to HQ (PRD §2, §14.2).
4. **No cross-database FKs or shared tables.** HQ ↔ outlet references are UUIDs validated against the owning authority (PRD §6, "Entity rules").
5. **Never replicate** user password hashes, refresh tokens, or outlet inventory balances into HQ master-menu tables (PRD §2).
6. **Secrets never cross into frontends.** HQ API keys, JWT signing keys, and the outlet machine key exist only in backend secret stores — env/secret-manager on HQ; the outlet's own `hq_connection` table for the machine key (written by the sealed setup wizard or the audited rotation route, PRD FR-11) — never in `VITE_*`, browser bundles, query strings, or logs (PRD §7.4, §9.2, §14.1).
7. Data authority is fixed (PRD §8.1): HQ owns the master catalog/assignments/prices; the outlet owns sales, inventory, receipts, and its outbox; HQ reporting is a read projection that discloses lag.

---

## 2. Universal wire-format rules (PRD §1.3, §7)

Every HTTP API in this repository MUST follow these rules without exception:

| Concern | Rule |
|---|---|
| Base path | Versioned under `/api/v1`. |
| Content type | `application/json` only. |
| JSON keys | `camelCase`. DTO class fields are `camelCase`. |
| IDs | UUID strings. Entities and events use UUIDs; only display receipts use the per-outlet counter (`A-000001`). |
| Money | Integer **minor units** serialized as canonical decimal **strings** (`"1200"`), matching `^(0\|[1-9][0-9]*)$`. Store `bigint` in PostgreSQL, compute with `bigint` in TypeScript. **NEVER** serialize money as a JS number or float. |
| Quantities | Positive integers, bounded (e.g., ≤ 100 distinct lines per sale). |
| Timestamps | ISO 8601 UTC instants ending in `Z`, stored as PostgreSQL `timestamptz`. |
| Revisions/sequences | Decimal strings of `bigint` (e.g., `"42"`, `"108"`). |

### 2.1 Response envelope (PRD §7.1)

Every successful response body is `ApiSuccess<T>`; every error body is `ApiError`:

```ts
type ApiSuccess<T> = { data: T; meta?: { requestId: string; timestamp: string; nextCursor?: string } };
type ApiError     = { error: { code: string; message: string; details?: Record<string, unknown>; requestId: string } };
```

- Backends: the envelope is applied by `common/interceptors/envelope.interceptor.ts` and `common/filters/global-exception.filter.ts`. **Controllers return the bare payload and NEVER wrap/envelope manually.** The only escape hatch is `@SkipEnvelope()` for the OpenAPI document routes.
- Frontends: the shared axios instance (`src/api/axios.ts`) unwraps the envelope once. Feature code NEVER re-parses the envelope.
- `X-Request-Id` is accepted/returned on every request. Client-created sales additionally require an `Idempotency-Key` header (PRD §7).

### 2.2 Error model (PRD §12)

- Use **only** the stable error codes from PRD §12 (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `ITEM_NOT_ASSIGNED`, `ITEM_INACTIVE`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_KEY_REUSED`, `RECEIPT_CONFLICT`, `EVENT_ID_CONFLICT`, `UNSUPPORTED_EVENT_VERSION`, `MENU_SNAPSHOT_REQUIRED`, `SYNC_TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`) plus the filter's built-in fallbacks (`NOT_FOUND`, `CONFLICT`, …). Never invent ad-hoc codes in a controller.
- Domain errors are thrown as typed exceptions carrying `{ code, message, details? }` (recognized by the global filter) — never by stringifying errors into `message`.
- HTTP status semantics: `401` unauthenticated, `403` permission/scope, `404` missing **or** cross-outlet-scope-hidden resource (never leak another outlet's data), `409` state/idempotency conflicts, `422` semantic rejection, `429` rate limited, `503` dependency unavailable.
- 5xx responses must never leak stacks or internals; the filter handles this — do not bypass it.

---

## 3. Backend rules — controllers, services, DTOs, Swagger (PRD §5, §7, §12)

These rules exist so that API code generated across both backends stays structurally identical. The **layered module rule** (PRD §5) is mandatory:

```
Controller  → HTTP DTOs, guards, Swagger decorators. No business logic, no TypeORM.
Service     → Business rules + transaction orchestration. No HTTP concepts (req/res).
Repository  → TypeORM queries and row locking. No HTTP calls, no business rules.
Worker      → Calls application services. NEVER controllers.
```

### 3.1 File and naming conventions

- Modules live in `src/modules/<feature>/` with `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts` (or `repositories/`), and `dto/`.
- Entities live in `src/database/entities/` (never inside feature modules); migrations in `src/database/migrations/` — real migrations only, **`synchronize: true` is forbidden** in every environment (PRD §6).
- DTO naming follows PRD §7.1: request DTOs are `<Verb><Noun>Request` (`CreateSaleRequest`, `AssignMenuRequest`, `EventBatchRequest`); response DTOs are `<Noun>Response` (`SaleResponse`, `OutletMenuResponse`, `CatalogChangesResponse`, `EventBatchResponse`). Collections are arrays of the singular response DTO with pagination carried in `meta.nextCursor`.
- Import style: ESM with `.js` specifiers, semicolons, double quotes — match `src/modules/health/` exactly.

### 3.2 DTO rules (class-validator + Swagger)

- Every endpoint has an explicit request DTO and an explicit response DTO class. **Entities are never serialized to clients** — services map to response DTOs.
- The NestJS Swagger CLI plugin is **not** enabled, so every DTO property MUST carry an explicit `@ApiProperty` / `@ApiPropertyOptional` with `type`, `example`, and (for money/revision fields) a description stating "minor units, decimal string" or similar. Money DTO fields are typed `string` with `example: '1200'`.
- Request DTOs validate everything the controller needs: `@IsUUID()` for IDs, `@IsInt() @Min(1)` for quantities, `@Matches(/^\d+$/)` style bounds for money inputs where client input is allowed (it usually is NOT — see §5 of this file), `@IsISO8601()` for timestamps, and array limits (`@ArrayMaxSize(100)`).
- Unknown fields are rejected globally (`whitelist + forbidNonWhitelisted + transform` in `makeGlobalValidationPipe()`); never loosen this per-route.
- Validation is defense-in-depth, not the only guard: services re-check business rules (stock, assignment, currency, totals) even when the DTO passed (PRD §12 validation matrix).

### 3.3 Controller rules

- One controller per resource; routes match PRD §7.2 (HQ) and §7.3 (outlet) exactly. Do not invent alternate route spellings.
- Every guarded route declares: `@ApiTags(<module>)`, `@ApiOperation({ summary })`, success `@ApiOkResponse({ type: <ResponseDto> })`, error `@ApiResponse`s for the codes it can emit, `@ApiSecurity('bearer-jwt')` for human routes or `@ApiSecurity('outlet-key')` for machine sync routes (scheme names are defined in `src/openapi/document.ts`).
- Auth + RBAC via route guards and the permission decorator from `common/rbac` with dot-case permission strings (`menu.write`, `sales.create`, `reports.read`, …) matching PRD §3/§9.3. Never check permissions inside a service by reading the request object.
- The outlet scope comes from the authenticated token/key (server-side identity), **never** from request JSON (PRD §3, §15).
- Controllers are thin: parse → guard → call service → return the service's DTO instance. If a controller contains an `if` on business state, that logic belongs in the service.

### 3.4 Service / repository rules

- Transactions: services own `QueryRunner`/transaction-manager orchestration. Every multi-write operation commits atomically or not at all (PRD §6, §8.6).
- **A catalog/menu mutation and its distribution record are ONE transaction.** Never commit a menu change and fan out `outlet_catalog_changes` (or any related-row write: key expiry on rotation, revoke, snapshot updates) in a follow-up transaction — a crash in between strands outlets with stale snapshots or locks principals out (PRD §8.2 rule 5).
- Row locks (`FOR UPDATE`, `SKIP LOCKED`) and **deterministic item-ID ordering** are the concurrency controls — never a JavaScript mutex (PRD §8.6). Any entity with a `version` column must be read with `FOR UPDATE` inside the mutation transaction before computing `version + 1`; a read-then-write without the lock is a lost-update bug.
- Repositories receive the transaction manager when participating in a transaction; they never open their own transactions for writes that are part of a larger unit — and they never silently fall back to the pool `DataSource` for such writes. A repository method that updates a row a service transaction depends on MUST take `manager` as its first parameter.
- Money arithmetic in `bigint` only. Converting to `number` for arithmetic is a bug.
- Config is read through `ConfigService<Env, true>` with `config.get('KEY', { infer: true })` — never `process.env` directly (PRD §14.1).
- Cross-module calls go through injected interfaces, not by importing another module's repository.

### 3.5 Swagger / OpenAPI contract workflow

- Swagger UI is mounted at `/api/v1/docs` and the machine-readable document at `/api/v1/openapi.json` (dev/admin-restricted) — already wired in `main.ts`.
- `pnpm openapi:export` regenerates `openapi/openapi.json`. **Any PRD-listed endpoint change MUST update this artifact in the same change**; frontends generate clients from it (§4.1).
- The OpenAPI document is the contract: if the implementation and the PRD example payloads disagree, fix the implementation and re-export.
- **The document must tell the truth about what the route emits**: NestJS answers `201` to `POST` handlers unless `@HttpCode` overrides it — declare `@ApiCreatedResponse` for 201 routes and `@ApiOkResponse` only where the status is really 200. A documented status the route never emits poisons generated clients' error handling.
- Every guarded route (including logout-style routes on otherwise-`@Public()` controllers) carries `@ApiSecurity('bearer-jwt')` / `@ApiSecurity('outlet-key')` so the exported document marks it protected.
- **Nullable DTO properties MUST declare an explicit `type`** (`@ApiProperty({ type: String, nullable: true })`). `nullable: true` alone exports `type: "object"`, and Kubb then generates `object | null` fields — a contract bug that surfaces as TypeScript errors in the frontend.

---

## 4. Frontend rules — API calling strategy (PRD §11)

### 4.1 Generated clients only

- All server communication MUST use **Kubb-generated** typed Axios clients + Zod schemas + TanStack Query helpers from the owning backend's exported OpenAPI document (`kubb.config.ts`, pinned version; PRD §11). Never hand-write `fetch`/`axios` calls, never manually maintain API DTO types that duplicate the contract.
- Generated code lives in `src/api/generated/` and is treated as build output: do not hand-edit it.
- The generated Axios client MUST be configured to reuse the shared instance/interceptors from `src/api/axios.ts` so that base URL, `X-Request-Id`, envelope unwrapping, auth header injection, and error normalization happen in exactly one place.
- Contract flow: backend merges → `openapi:export` → copy the artifact into `src/api/contracts/` → regenerate in the frontend (a pinned `generate:api` script + `kubb.config.ts` per app, required from Phase 1 per PRD §11/§18 — not yet present in the Phase-0 shells). Block work that leaves generated clients stale.

### 4.2 Server state and validation

- TanStack Query is the only server-state mechanism: queries for reads (feature-scoped key factories, e.g. `menuKeys.list()`), mutations for writes. No ad-hoc `useEffect` fetching, no server data duplicated into component state.
- TanStack Router validates all query/search params with Zod (`validateSearch`); forms validate with Zod schemas in `src/schemas/`.
- **Frontend validation is UX, not a security control** (PRD §5, §9.3). The backend re-validates everything; route/permission hiding in the UI is cosmetic.
- Parse high-risk API responses (money-bearing payloads) with the generated Zod schemas before use — concretely, the `queryFn` awaits the generated client and returns `<op>Status200Schema.parse(...)`; the parsed value is what feeds render. Auth-session payloads are parsed too, narrowing permission strings to the typed catalog.

### 4.3 Money, auth, and errors

- Money stays a string end-to-end. Never `Number(totalMinor)` — not even "just for display": the minor-unit formatter in `lib/utils` must do pure string/integer math (slice/group digits), because `Number(minor) / 100` silently corrupts values beyond 2^53 minor units.
- Access token lives in memory; refresh token in the `HttpOnly` cookie set by the backend. The axios layer attaches `Authorization: Bearer` and performs a single refresh-and-retry on `401` before logging out (PRD §9.1). Never store tokens in `localStorage`.
- All API failures surface as the shared `ApiError` (`code`, `requestId`, `details`). UI renders `error.message` and stable codes — never raw Axios errors.

### 4.4 Financial-action discipline (outlet POS critical)

- **No optimistic updates for stock or money.** Confirmation comes from the authoritative backend response (PRD §11). Optimistic UI is allowed only for non-financial actions.
- A sale attempt mints **one** `Idempotency-Key`, kept stable across retries/timeouts (survive the retry with the same key — e.g., hold it in component/session state until a response or abandonment). Never mint a second key for the same attempted sale (PRD §7.3, §11, AT-07/AT-08).
- The client never sends price, total, receipt number, or outlet ID with a sale — only `menuItemId` + `quantity` lines (PRD §7.3, §15).
- HQ report views must always render `dataAsOf` / per-outlet sync watermarks so stale data is never mistaken for zero sales (PRD §8, AT-20).

### 4.5 Design system (both frontends)

The single source of truth is [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) (editorial: off-white canvas, warm ink, EB Garamond display + Inter body, hairline cards, pill CTAs, pastel gradient orbs). Non-negotiable rules:

- Token utilities only — **no hardcoded hex/rgba in components**. All colors, type sizes, radii, and shadows come from the `@theme`/`:root` tokens in each app's `src/styles.css`.
- The near-black **ink pill is the only primary CTA color** (`bg-primary` / `.btn-primary`). No saturated action color, no gradient buttons, no glow shadows.
- Display type (`font-display`) **stays at its token weight — never bold**. Body stays Inter 400/500/600.
- Gradient orbs (mint/peach/lavender/sky/rose) are `aria-hidden` **decoration only** — never fills for interactive elements or text colors.
- Money and aligned numerals render with `.money` (Inter + tabular numerals), never `font-mono`; the money value itself stays a string (§4.3).
- **No dark mode** — never add a theme toggle or `.dark` values; dark surfaces are fixed tokens for deliberate dark bands.
- Fonts are **self-hosted** via Fontsource — never introduce a CDN font import (outlets run offline).
- `hq-frontend/src/styles.css` and `outlet-frontend/src/styles.css` are **byte-identical**: change one, copy to the other in the same change, and update DESIGN_SYSTEM.md when tokens/classes change.

---

## 5. Server-authoritative computation (PRD §7.3, §8.4, §15)

- Prices, totals, receipt numbers, `soldAt`, and outlet identity are computed by the backend. Any client-supplied value for these is ignored or rejected.
- Historical snapshots are immutable: sale lines keep name/SKU/unit price at sale time; a later HQ price change never rewrites a receipt or a synced event (PRD FR-02, AT-02, AT-19).
- Integrity invariants are enforced at commit: `sum(subtotal) = total`, `quantity × unitPrice = subtotal`, unique `(outletId, receiptNo)`, unique `(outletId, eventId)` and `(outletId, sequenceNo)`.

---

## 6. Tooling, testing, and quality gates

- **pnpm only** (pinned via `packageManager`); never commit `node_modules`; never mix lockfiles.
- Backends: `pnpm lint` (oxlint), `pnpm test` (Vitest), `pnpm test:e2e`, `pnpm migration:run|revert|show`, `pnpm openapi:export`. Frontends: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm check` (format).
- **Frontend `pnpm build` MUST type-check before bundling** (`tsc --noEmit && vite build`). A build script that only bundles lets type errors ship — Vite does not type-check. `tsc --noEmit` must be clean before any frontend change is considered done. (Unused-code detection runs in ESLint, not `tsc`, because generated output cannot satisfy `noUnusedLocals` — see each app's `AGENTS.md`.)
- Concurrency/transaction tests run against **real PostgreSQL + Redis** containers — SQLite is insufficient for row-lock behavior (PRD §17).
- Acceptance scenarios AT-01…AT-23 (PRD §17) are the definition of done; new features cite the scenarios they satisfy.
- Structured JSON logs carry `requestId`, `outletId`, `eventId`, `saleId`, `receiptNo`, `revision` as applicable — and never secrets, keys, or password hashes (PRD §13, §15).
