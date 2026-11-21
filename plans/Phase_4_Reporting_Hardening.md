# Phase 4 — Reporting / hardening (revenue & top items, staleness, audit views, security & load tests)

## Context

Phase 0–3 delivered: the four independent apps, HQ auth/RBAC/menu/assignments/api-keys, outlet catalog cache/inventory/atomic-idempotent sales, the full sync loop (typed machine client, menu pull/snapshot, BullMQ dispatcher, transactional HQ inbox with `hq_sales`/`hq_sale_items` projections and their reporting indexes, per-event ACKs, reconciliation, offline-grace policy with audited override). `GET /outlets/:id/sync-status` (`sync.read`) already exposes per-outlet watermark/backlog/heartbeat, and `reports.read` is defined and seeded (HQ_ANALYST) but backs no endpoint.

Phase 4 per PRD §18: **revenue/top items, staleness indicators, admin dashboards, audit, cross-outlet security tests, load/concurrency/failure tests**. Per the user's PRD edit, **backup & recovery rehearsal and production rollout are omitted** from this phase (and from this plan). The Phase 3 AT-22 best-effort drill remains the recorded evidence; nothing new is planned there.

**Scope decisions (confirmed by user):**
- **Skip metrics entirely.** Structured JSON logs + health endpoints stay as-is; no Prometheus `/metrics`, no OpenTelemetry, no ops dashboards (that direction was cut with production rollout).
- **HQ worker stays BullMQ-free.** `report-refresh` is skipped (reports are computed on request from indexed projections — PRD marks the queue optional); audit retention runs as a plain interval timer in `worker-main.ts`. No `bullmq` dependency is added to hq-backend; the stale `QUEUES` constant is cleaned up.
- **Audit views are HQ-only** (PRD §11 lists "audit views" under the HQ frontend). The outlet audit table stays a write-only compliance trail (its sync/adjust/override events already surface via `GET /sync/status` and the POS banner).
- **Load tests use `autocannon`** (pinned devDependency in outlet-backend) driving dynamic-body concurrent sales against the compose outlet API, asserting the PRD §16 p95 < 500 ms target.

**Implementation decisions (PRD-faithful, made during planning):**
- Reports read **only** the HQ projections (`hq_sales`/`hq_sale_items`), never outlet databases (FR-08). All aggregation is SQL `bigint`; sums serialize as canonical decimal strings. No caching layer, no materialized views — the Phase 3 partial indexes (`idx_hq_sales_reporting`, `idx_hq_sale_items_item`) exist for exactly these queries.
- **Staleness contract (AT-20):** report-level `dataAsOf = max(ingested_at)` across all outlets (null when nothing ingested); per-outlet `lastIngestedAt` is that outlet's all-time max `ingested_at` (a freshness watermark independent of the query window, so an outlet with zero in-window sales still shows when it last reported). `isProvisional = true` when any ACTIVE outlet has `pendingOutboxCount > 0` in its last heartbeat backlog **or** has never ingested an event. Every ACTIVE outlet appears in the revenue list even with zero sales — a missing contribution must never read as "no sales" (§10).
- **Time mode is UTC-only in V1** (§10 default; outlet-local business-day mode stays a future option). `from` inclusive, `to` exclusive, both required, `@IsISO8601`, `from < to`, span bounded to 366 days (§15 unbounded-query protection). Optional `currency` filter defaults to the company currency; unlike currencies are never summed.
- **Top items:** `limit` defaults to 5 and is capped at 5 in V1 (§7.2 "max 5"); group by `menu_item_id`, order `quantitySold DESC` then `menu_item_id` (deterministic tie-break, §10); `itemName` joins current `master_menu_items` name, falling back to `name_snapshot` for archived items.
- **`audit.read` is a new HQ permission** granted to HQ_SUPER_ADMIN only (§9.3 matrix gives analysts no audit row). Seeding is idempotent; the plan documents a re-seed step for existing environments. Audit rows remain immutable; the retention timer **defaults to disabled** (`AUDIT_LOG_RETENTION_DAYS=0`) so immutability is the out-of-the-box behavior.
- **Security tests are self-contained per backend:** each e2e suite forges tokens with a wrong secret / wrong `iss` / wrong `aud` / expired claims (asserting 401) and walks the §9.3 permission matrix with seeded role tokens. Cross-issuer isolation (outlet JWT ⇒ HQ API, HQ JWT ⇒ outlet API) is proven by issuer/audience validation plus the independent-secrets design (§9.1), not by sharing secrets between test suites.
- **Load harness correctness:** every request mints a fresh `Idempotency-Key` + `X-Request-Id` and a varied item mix via autocannon's per-request `setup` — otherwise replayed bodies would return cached idempotent 200s and fake the results. Stock is pre-restocked through the audited `POST /inventory/adjustments` path so balances never bind during a run. *(As-built amendment: the adjustment `reason` is `"RESTOCK"`, not `"LOADTEST"` — the production DTO enum is `RESTOCK | WRITE_OFF | RECOUNT`, and adding a test-only enum value would ripple into the API contract and generated clients. Load-test restocks stay distinguishable in post-run SQL via their `perf-` request IDs and manager actor.)*

**Out of scope:** metrics/OpenTelemetry/alerting, HQ BullMQ queues, outlet audit UI, inventory→HQ stock events (§8.1 optional), outlet-local business-day reporting, void/refund compensating events, `.github` CI workflows, backup/restore rehearsal, production rollout/runbooks/ops dashboards, multi-currency FX.

**Acceptance scenarios targeted:** AT-17 (full permission/issuer depth), AT-20 (staleness disclosure) — plus load/failure evidence for the §16 rows "local sale p95 < 500 ms", "0 oversells / 0 duplicate receipts" at load, and regression green for AT-01…AT-21. AT-22 omitted with the backup/recovery direction.

**Commit policy (as Phases 1–3):** every task below lands as exactly one commit with the stated message, only after its gates pass (`pnpm lint && pnpm test` on every backend task; `pnpm test:e2e` where DB-dependent; `pnpm lint && pnpm build && pnpm check` on frontend tasks). Backend tasks that add routes MUST re-run `pnpm openapi:export` and commit the regenerated `openapi/openapi.json` in the same commit (root AGENTS §3.5).

---

## HQ backend tasks

Existing scaffolding reused: `hq_sales`/`hq_sale_items` entities + `sync_outlet_checkpoints` (Phase 3), `hq-sync-status.service.ts` watermark reads, `audit.service.ts` write path + `audit_logs` table (Phase 1), envelope/filter/throttler, `reports.read` in `common/rbac/permissions.ts`.

### H1 — Revenue-by-outlet report
> Commit: `feat(hq-backend): add revenue-by-outlet reporting`

- `modules/reporting/` (module, controller, service, repository, `dto/`): `GET /reports/revenue-by-outlet?from=&to=&currency=` (`reports.read`, §7.2/§10).
- Query: `SUM(total_minor)`, `COUNT(*)` from `hq_sales` where `status='COMPLETED'` and `sold_at >= from and sold_at < to`, grouped by outlet; **every ACTIVE outlet is returned** (zero-sale outlets carry `"totalRevenueMinor": "0"`, `completedSaleCount: 0`, per-outlet `lastIngestedAt` all-time watermark, null if never ingested).
- Response `RevenueByOutletResponse` exactly per §10 example: `currencyCode`, `outlets[]` (`outletId`, `outletName`, `totalRevenueMinor` decimal string, `completedSaleCount` int, `lastIngestedAt`), `totalRevenueMinor`, `dataAsOf`, `isProvisional` (definition above). DTO validation: `@IsISO8601` `from`/`to`, `from < to`, span ≤ 366 days, optional `currency` `@Matches(/^[A-Z]{3}$/)`.
- Swagger: `@ApiTags('reports')`, `@ApiSecurity('bearer-jwt')`, explicit `@ApiOkResponse({ type })`, money/revision properties documented as decimal strings (root AGENTS §3.2).
- Unit specs: window boundaries (inclusive/exclusive), zero-sale outlet inclusion, decimal-string sums (bigint, > 2^53 fixture), `isProvisional` truth table (backlog vs never-ingested), window-validation rejections.
- Gates: `pnpm lint && pnpm test` + `pnpm openapi:export` (artifact committed).

### H2 — Top-items report
> Commit: `feat(hq-backend): add per-outlet top-items reporting`

- `GET /reports/outlets/:id/top-items?from=&to=&limit=5` (`reports.read`): join `hq_sale_items` → `hq_sales` for the outlet + window, `GROUP BY menu_item_id`, `SUM(quantity)`, order `quantitySold DESC, menu_item_id`, rank 1..n; `itemName` from `master_menu_items` (fallback `name_snapshot`); unknown outlet → 404.
- Response `OutletTopItemsResponse` per §10 example (`rank`, `menuItemId`, `itemName`, `quantitySold` int; `dataAsOf`). `limit` `@IsInt @Min(1) @Max(5)`, default 5 (V1 cap, §7.2).
- Unit specs: deterministic tie-break, archived-item name fallback, window boundaries, limit cap, outlet isolation (outlet A report never contains B rows).
- Gates: lint/test + `pnpm openapi:export`.

### H3 — Audit read API
> Commit: `feat(hq-backend): add audit log read API`

- New permission `audit.read` in `common/rbac/permissions.ts` (HQ_SUPER_ADMIN only); seed adds the permission + role mapping idempotently (documented re-seed step: `pnpm seed` on existing HQ databases).
- `modules/audit/` gains `audit.controller.ts` + `dto/`: `GET /audit/logs?cursor=&limit=&action=&actorId=&entityId=&from=&to=` (`audit.read`): immutable read-only listing ordered `occurred_at DESC, id DESC` (deterministic cursor), `limit` ≤ 100 default 50, cursor pagination via `meta.nextCursor` (§3.1); response rows `AuditLogResponse` (`id`, `actorType`, `actorId`, `action`, `entityId`, `metadata`, `occurredAt`).
- Unit specs: cursor stability under concurrent writes, filter combinations, role denial (analyst/menu-manager 403), limit clamp.
- Gates: lint/test + `pnpm openapi:export`.

### H4 — Worker audit-retention timer
> Commit: `feat(hq-backend): add worker audit retention timer`

- `worker-main.ts`: remove the dead `QUEUES` constant (no BullMQ in hq-backend); add an interval timer (hourly check) that, when `AUDIT_LOG_RETENTION_DAYS > 0`, deletes `audit_logs` older than the cutoff in bounded batches (≤ 1000 rows/pass) and logs a structured summary `{deleted, cutoff}`. Default `0` = disabled (immutable-by-default).
- `env.schema.ts` + `.env.example`: `AUDIT_LOG_RETENTION_DAYS` (worker profile, int ≥ 0, default 0).
- Unit specs: disabled default performs no deletes, batch bounding, cutoff math.
- Gates: lint/test.

### H5 — Reporting/audit e2e (AT-20)
> Commit: `test(hq-backend): verify report accuracy and staleness disclosure`

- New `test/e2e/reporting.e2e-spec.ts` (real Postgres, self-skipping without env — mirror Phase 3 helpers): push known sale batches through `/sync/v1/events/batch` for outlet A only, then assert — revenue report totals match pushed totals **exactly** as decimal strings (bigint fixture > 2^53), counts and currency correct; outlet B present with `"0"`/`null lastIngestedAt`; `dataAsOf` equals A's last `ingested_at`; `isProvisional` flips when B's heartbeat reports backlog (AT-20); `from`/`to` boundary sales land on the correct side; top-items ranking, tie-break, and cross-outlet isolation.
- New `test/e2e/audit.e2e-spec.ts`: auth events (login, refresh reuse, key rotate) recorded and readable via `/audit/logs` with action/actor filters + cursor paging; analyst token → 403.
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` green.

### H6 — Cross-issuer/permission security e2e (AT-17)
> Commit: `test(hq-backend): verify token issuer and permission isolation`

- New `test/e2e/security.e2e-spec.ts`: forged JWTs (wrong secret, wrong `iss`, wrong `aud`, expired, disabled user) → 401 on `/menu-items`; §9.3 matrix walk with seeded role tokens — analyst `POST /menu-items` → 403, menu-manager `POST /outlets/:id/api-keys` → 403, analyst `GET /reports/*` → 200, menu-manager without `reports.read` → 403; outlet-key auth on human routes → 401 and bearer JWT on `/sync/v1/*` → 401 (no crossover); unknown outlet on `/outlets/:id/sync-status` → 404 (no leak).
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` green.

---

## Outlet backend tasks

No new outlet runtime features: reports are HQ-only, audit stays write-only, metrics skipped. Phase 4 adds tooling and test depth only.

### O1 — Sale-load harness (autocannon)
> Commit: `perf(outlet-backend): add autocannon sale load harness`

- devDependency `autocannon` (pinned); script `scripts/perf/sale-load.ts` (run via `pnpm perf:sale`, tsx) + `package.json` script.
- Flow: login as seeded manager (credentials via env/flags) → pre-restock every active catalog item through `POST /inventory/adjustments` (audited; `reason: "RESTOCK"` — see the as-built note above) → warmup → autocannon run against `POST /sales` with per-request `setup` minting a fresh `Idempotency-Key` + `X-Request-Id` and varying the item/quantity mix within catalog bounds; flags for duration, concurrency, rate.
- Output: p50/p95/p99, rps, non-2xx count; exit non-zero when p95 exceeds the threshold flag (default 500 ms, §16) or any request errors. Secrets never printed.
- README (backend) documents the run against compose `outlet-a-api`.
- Gates: `pnpm lint && pnpm test`; one documented manual run (see V2).

### O2 — Permission/failure e2e additions
> Commit: `test(outlet-backend): extend permission and delivery failure coverage`

- Extend/verify (add only what's missing after auditing the existing suites): forged-token matrix (wrong secret / `iss` / `aud` / expired → 401 on `/menu`); §9.3 legs not yet covered — inventory clerk `POST /sales` → 403, cashier `POST /inventory/adjustments` → 403; delivery failure legs — stubbed HQ returning 503-then-200 (retry → `DELIVERED`, `sync_attempt_logs` rows) and 429 with `Retry-After` honored on `next_attempt_at`.
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` green (`fileParallelism: false` respected).

---

## Frontend tasks (hq-frontend only — outlet-frontend has no Phase 4 surface; its contract is unchanged)

### F1 — Contract refresh + reports pages
> Commit: `feat(hq-frontend): add revenue and top-items reports`

- Copy refreshed `hq.openapi.json` → `src/api/contracts/`; `pnpm generate:api` (no hand edits; no-diff on re-run).
- `features/reports/` + route `_auth/reports.tsx`: `from`/`to` date filters validated with Zod via TanStack Router `validateSearch`; revenue table (`.money` string formatting via the pure formatter — §4.3) showing per-outlet revenue, count, `lastIngestedAt`; **staleness always visible**: `dataAsOf` header + `isProvisional` badge ("provisional — outlets may have unsynced sales"), never-ingested outlets rendered explicitly (AT-20 leg of §4.4). Top-items panel with outlet picker (`limit` fixed 5). `queryFn`s parse money-bearing payloads with the generated Zod schemas (§4.2).
- Gates: `pnpm generate:api` no-diff, `pnpm lint && pnpm build && pnpm check`.

### F2 — Dashboard upgrade + sync-health panel
> Commit: `feat(hq-frontend): add outlet health dashboard with sync staleness`

- `_auth/dashboard.tsx`: replace the Phase-4 placeholder — revenue summary card (current-month window from the reports API, `dataAsOf` shown), outlet health grid wiring the already-generated `useSyncAdminControllerGetSyncStatus` per outlet: menu revision, last event/heartbeat times, reported backlog (pending/quarantined), stale color state (never-ingested / backlog > 0 / heartbeat old). No optimistic server state; errors render `ApiError.code` + message (§4.3).
- Gates: `pnpm lint && pnpm build && pnpm check`.

### F3 — Audit views
> Commit: `feat(hq-frontend): add audit log views`

- `features/audit/` + route `_auth/audit.tsx` (admin-only; route hiding is cosmetic — backend `audit.read` enforces): cursor-paginated table (`meta.nextCursor` load-more), filters for action/actor/date range (Zod-validated search params), metadata rendered read-only. `audit.read` added to the typed permission catalog in `lib/permissions.ts`.
- Gates: `pnpm lint && pnpm build && pnpm check`.

---

## V — Verification

### V1 — End-to-end reporting/staleness + security sweep
> Commit: `docs: document Phase 4 verification results`

1. Full `docker compose up -d` + seeds (+ HQ re-seed for `audit.read`) + key provisioning (Phase 3 loop).
2. **AT-20 drill:** POS sales at outlet A while `hq-api` is stopped → restart → before backlog drains, HQ reports page shows A stale/provisional with old `dataAsOf` → after drain, totals match SQL `SUM(total_minor)` on `hq-db` exactly; B-with-no-sales renders "never reported", never "0 sales".
3. **AT-02/AT-19 regression through reporting:** price override sale then HQ price change → report revenue reflects sold snapshots, not new prices.
4. **Security sweep:** forged tokens rejected on both APIs; §9.3 matrix spot-checks via curl; `hq-frontend` bundle greps clean of secrets; `/sync/v1/*` unreachable from the browser (no CORS).
5. **Audit trail:** perform login-failures/refresh-reuse/key-rotate → visible in the HQ audit page with filters.
6. Update root `README.md` (Phase 4 section: reports, staleness semantics, audit, perf results) + backend READMEs.

### V2 — Load run + integrity assertions
> Commit: `docs: record sale-load baseline and integrity results`

1. `pnpm perf:sale` against compose `outlet-a-api` (documented flags: e.g. 60 s, 25 concurrent), baseline p50/p95/p99 recorded in README (§16 target: p95 < 500 ms on the assessment host, explicitly "subject to hardware").
2. Post-run SQL integrity on `outlet-a-db`: zero duplicate `receipt_no`, `quantity_on_hand = initial + LOADTEST restock − sold quantity` per item (0 oversells), every sale has exactly one outbox row; HQ-side: one `hq_sales` row per sale after sync, totals match (§16 "durable delivery" rows).

---

## Definition of done (Phase 4)

- AT-17 and AT-20 pass end-to-end; AT-01…AT-21 suites remain green (regression).
- Revenue/top-items reports read only HQ projections; totals match pushed sale events exactly as decimal strings (SQL-verified); every ACTIVE outlet appears with explicit freshness; `isProvisional`/`dataAsOf` never let stale data read as zero.
- Audit read API + HQ audit page live with `audit.read` enforced; audit rows immutable by default (retention timer off unless configured).
- Load baseline recorded; 0 oversells, 0 duplicate receipts, no sale without outbox row at load; no double-counted HQ revenue.
- `openapi:export` artifacts and hq-frontend generated clients current (`generate:api` is a no-op diff); outlet-frontend untouched and building.
- No metrics/OTel added (per decision); no backup/recovery or production-rollout work performed (omitted per user direction).
