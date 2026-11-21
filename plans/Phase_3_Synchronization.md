# Phase 3 — Synchronization (outlet worker ⇄ HQ sync API, typed end to end)

## Context

Phase 0–2 delivered: both backends' human surfaces (HQ auth/RBAC/users/outlets/menu/assignments/api-keys; outlet auth/RBAC/users/menu-read/inventory/atomic-idempotent-sales), the outlet outbox **write** path (`PENDING` rows only), offline-grace enforcement, both frontends, and the compose topology (`hq-sync` network: outlet-a-worker → hq-api only, outbound).

Phase 3 per PRD §18: **typed HQ sync client, pull deltas/snapshot, BullMQ dispatcher/workers, HQ transactional inbox ingestion, per-event ACKs, retries, reconciliation, status and alerting, offline policy** — the complete outlet⇄HQ synchronization loop, implemented from the outlet worker down to HQ projection rows, verified under outages.

**Scope decisions (confirmed by user):**
- **Phase 3 only.** Reporting, dashboards, and hardening are Phase 4 (separate plan).
- **Single-response snapshot** (§8.3): `GET /sync/v1/menu/snapshot` returns `snapshotId` + `snapshotRevision` + all items in one response; the outlet applies it in one atomic transaction (upsert + mark-absent-inactive + checkpoint). No paging, no staging table. The `snapshotRequired` gap-recovery contract stays intact.
- **Emergency grace override in scope** (§8.8, deferred from Phase 2): privileged + audited extension of the offline grace window.
- **One commit per task**, only after its gates pass.

**Implementation decisions (PRD-faithful, made during planning):**
- **Batch-level idempotency store is skipped.** PRD §8.5 says HQ "*may* store a batch key + request hash"; event-level `(outletId, eventId)` / `(outletId, sequenceNo)` dedupe is the ultimate key. Same batch retried with same bytes → every event returns `DUPLICATE`; same batchId with changed payload → event-level `REJECTED_PERMANENT`/`DUPLICATE` outcomes. No extra table.
- **Machine client is Kubb-generated** (PRD §11: "typed machine client … request interceptor adding the outlet key"): pinned Kubb config inside `outlet-backend`, filtered to the HQ `sync` OpenAPI tag, output treated as build output. Zod response parsing validates every HQ reply against the contract (§8.3 "validate response with the versioned contract").
- **Catalog fan-out stays synchronous** in HQ admin transactions (Phase 1 pattern, §8.2 rules 1–3). The §8.2-rule-5 async fan-out queue is out of scope at V1 outlet counts; the HQ worker keeps its heartbeat only.
- **Outlet audit log is added** (`outlet_audit_logs`): §8.8 requires the grace override to be "privileged, audited" and outlet-backend has no audit table; §6.2 field lists are non-exhaustive (same precedent as Phase 2's `stock_movements.request_id`).
- **HQ ingest is synchronous in the API process** (§8.6 "HQ inbox transaction (per event)"); no HQ-side queue is needed for correctness, and `hq_sales` projections are written in the same transaction as inbox rows.
- **BullMQ via plain providers** (`bullmq` queues/workers as custom providers), matching the repo's DI style; jobs carry **event IDs only** (§13) and processors reload durable rows. The DB sweeper — not BullMQ scheduling — is the source of truth for retry eligibility (§8.6 G).
- **Quarantine repair**: `REJECTED_PERMANENT` rows stay `QUARANTINED` with `last_error` and are visible in `GET /sync/status`; the manual repair/replay workflow is an outlet-manager endpoint (`POST /sync/outbox/:eventId/replay`) that re-arms a quarantined row after operator review (§8.5 "provide a manual repair/replay workflow").
- Sync routes get a dedicated `@Throttle` (600/min) above the global 100/min guard, so catch-up pushes are never rate-limited by the human default (§7.4).
- HQ `GET /outlets/:id/sync-status` (§7.2, `sync.read`) lands in Phase 3 (it reads `sync_outlet_checkpoints`, which Phase 3 creates); the HQ dashboard UI that consumes it is Phase 4.

**Out of scope (Phase 4+):** revenue/top-items reporting, HQ dashboards/audit views, inventory→HQ stock events (§8.1 optional), daily deep reconciliation job (hourly checkpoint reconciliation **is** in scope), `.github` CI workflows, load tests.

**Acceptance scenarios targeted:** AT-01, AT-02 (end-to-end: HQ change → outlet menu), AT-09, AT-10, AT-11 (full, incl. override), AT-12, AT-13, AT-14, AT-15, AT-16, AT-21, AT-22 (drill). AT-20 needs reporting → Phase 4.

**Commit policy (per user instruction):** every task below lands as exactly one commit with the stated message, only after its gates pass (`pnpm lint && pnpm test` on every backend task; `pnpm test:e2e` where DB-dependent; `pnpm lint && pnpm build && pnpm check` on frontend tasks). Backend tasks that add routes MUST re-run `pnpm openapi:export` and commit the regenerated `openapi/openapi.json` in the same commit (root AGENTS §3.5).

---

## HQ backend tasks

Existing scaffolding reused: `outletKeySecretMatches` + `OUTLET_KEY_SCOPES` (`src/common/utils/outlet-key.ts`), `outlet_api_keys` entities/repository, `outlet_catalog_changes`/`outlet_catalog_revisions` (Phase 1 fan-out, §8.3-shaped payloads), `ApiException` + filter, envelope interceptor, throttler, `OUTLET_KEY_PEPPER` on the api env profile, `outlet-key` OpenAPI scheme in `src/openapi/document.ts`.

### H1 — Sync schema: entities + migration
> Commit: `feat(hq-backend): add sync inbox and sales projection schema`

- Entities: `SyncInboxEventEntity` (`sync_inbox_events`: id, outlet_id, event_id, sequence_no bigint, event_type, payload_sha256, schema_version, status, received_at), `HqSaleEntity` (`hq_sales`: id, outlet_id, source_sale_id, receipt_no, sold_at, total_minor bigint, currency_code, status, ingested_at), `HqSaleItemEntity` (`hq_sale_items`: id, hq_sale_id, source_sale_item_id, menu_item_id, name_snapshot, quantity, unit_price_minor, subtotal_minor), `SyncOutletCheckpointEntity` (`sync_outlet_checkpoints`: outlet_id PK, highest_contiguous_sequence, last_event_at, last_reported_backlog, last_menu_seen_revision, last_heartbeat_at).
- Migration `1730000000000-hq-phase3-sync.ts`: tables + the PRD §6.1 SQL block — `uq_hq_sale_source`, `uq_hq_receipt`, `uq_hq_inbox_event`, `uq_hq_inbox_sequence`, partial `idx_hq_sales_reporting`, `idx_hq_sale_items_item`, `sync_inbox_events(outlet_id, received_at DESC)`. Register entities in `src/config/database.config.ts`; verify `openapi:export` still boots.
- Gates: `pnpm lint && pnpm test`; `pnpm migration:run` → `migration:revert` → `migration:run` against compose `hq-db` (`127.0.0.1:15432`).

### H2 — OutletKey guard + scopes
> Commit: `feat(hq-backend): add outlet machine-key auth guard`

- `common/auth/outlet-key.guard.ts` (+ `@RequireKeyScopes('menu.pull')` decorator): parses `Authorization: OutletKey <keyId>.<secret>`; loads the key by `keyId`; rejects non-ACTIVE / expired / wrong-scope (401 `UNAUTHENTICATED`; scope miss → 403 `FORBIDDEN`); constant-time HMAC verify against `OUTLET_KEY_PEPPER`; updates `last_used_at` (non-blocking) in the key repo; attaches `{ outletId, scopes }` to the request. Outlet identity comes **only** from the key record (§7.4) — request bodies never influence it.
- Audit rows for authentication failures (repeated failures feed AT-16 evidence). Guard is module-scoped for `SyncIngestModule` only — never global (human JWT routes must not change).
- Unit specs: unknown keyId, wrong secret, revoked, expired, grace-window rotated-out, missing scope, lastUsedAt write.
- Gates: lint/test.

### H3 — Menu pull endpoints (`/sync/v1/menu/changes`, `/sync/v1/menu/snapshot`)
> Commit: `feat(hq-backend): add outlet menu sync pull endpoints`

- `modules/sync-ingest/`: `GET /sync/v1/menu/changes?afterRevision=&limit=` (scope `menu.pull`, limit ≤ 500): rows from `outlet_catalog_changes` where `revision > afterRevision`, ascending, for the key's outlet only. Response `CatalogChangesResponse { outletId, fromRevision, nextRevision, headRevision, hasMore, snapshotRequired, changes[] }` per §8.3 example (revision decimal strings; change entries map the stored §8.3 payload). `snapshotRequired=true` when `afterRevision + 1 < min(available revision)` (gap/truncation) — return no changes then.
- `GET /sync/v1/menu/snapshot` (scope `menu.pull`): built in a single repeatable-read transaction → `MenuSnapshotResponse { snapshotId (uuid), snapshotRevision, items[] }` where items are the full §8.3 per-item shape for all assignments (active and inactive — inactive carry `active:false` so the outlet can tombstone).
- Never 404/leak for a healthy outlet with no changes: `changes: []` + `hasMore: false` (FR-03: empty change response cannot delete local data).
- Swagger: `@ApiTags('sync')`, `@ApiSecurity('outlet-key')`, explicit request/response DTOs with decimal-string money/revision `@ApiProperty`s; `@Throttle` 600/min.
- Unit specs: ascending contiguity, afterRevision boundary, limit/hasMore, gap → snapshotRequired, cross-outlet isolation (outlet A key never sees B rows — AT-16), snapshot head consistency.
- Gates: lint/test + `pnpm openapi:export` (artifact committed).

### H4 — Event batch ingest (`/sync/v1/events/batch`)
> Commit: `feat(hq-backend): add transactional event ingest with per-event acks`

- `POST /sync/v1/events/batch` (scope `events.push`): `EventBatchRequest { batchId: UUID, events: SyncEventV1[] }` with `@ArrayMaxSize(100)`; `Idempotency-Key` header required; body capped at `SYNC_MAX_BODY_BYTES` (413).
- Outlet check first: any event whose `outletId` ≠ key's outlet ⇒ **entire request** 403 `FORBIDDEN` (§7.4).
- Per event (§8.6 HQ inbox transaction, one transaction each): validate against `contracts/sync-event-v1.schema.json` semantics (schemaVersion unsupported → `REJECTED_PERMANENT` result, detail `UNSUPPORTED_EVENT_VERSION`; integrity invariants quantity×price=subtotal, Σ=subtotal=total re-verified in bigint) → insert `sync_inbox_events` (unique `(outletId,eventId)`, `(outletId,sequenceNo)`, `payload_sha256`) → insert `hq_sales` + `hq_sale_items` projection → advance `sync_outlet_checkpoints.highest_contiguous_sequence` only across filled gaps → commit. Outcomes per event: `ACCEPTED`, `DUPLICATE` (same canonical hash — terminal success, AT-09), `REJECTED_PERMANENT` (identity reuse with different payload, `EVENT_ID_CONFLICT` + audit alert, never overwrite — AT-15), `RETRYABLE_ERROR` (transaction failure). HTTP 200 with mixed statuses; batch-level 401/403/413/429/5xx handled by the worker as whole-request.
- Response `EventBatchResponse { batchId, results: [{ eventId, status, retryable, acknowledgedAt? }], highestContiguousSequence }` per §8.5.
- Out-of-order sequences ingest fine; the checkpoint advances only contiguously (AT-21).
- Unit specs: all five outcomes, whole-batch outlet mismatch, invariant rejection, projection uniqueness on replay, contiguous-checkpoint gaps.
- Gates: lint/test + `openapi:export`.

### H5 — Checkpoint, heartbeat, HQ sync-status
> Commit: `feat(hq-backend): add sync checkpoint, heartbeat, and outlet sync-status`

- `GET /sync/v1/checkpoint` (scope `events.push`): `{ outletId, highestContiguousSequence, missingRanges: [{from,to}] }` computed from inbox sequences (reconciliation input).
- `POST /sync/v1/heartbeat` (scope `status.write`): body `{ appliedMenuRevision, pendingOutboxCount, quarantinedCount, oldestPendingAt? }` → upsert into `sync_outlet_checkpoints` (`last_reported_backlog`, `last_menu_seen_revision`, `last_heartbeat_at`); response `{ acknowledgedAt }`.
- `GET /outlets/:id/sync-status` (human JWT, `sync.read`, §7.2): `{ outletId, currentMenuRevision, highestContiguousSequence, lastEventAt, lastHeartbeatAt, lastReportedBacklog, lastMenuSeenRevision, quarantinedCount }` from `outlet_catalog_revisions` + checkpoints (FR-10). Cross-outlet scope is enforced by plain permission (HQ staff see all outlets).
- Gates: lint/test + `openapi:export`.

### H6 — HQ sync-ingest e2e suite
> Commit: `test(hq-backend): verify sync ingest dedup, ordering, and key scoping`

- New e2e specs (real Postgres, self-skipping without env — mirror Phase-1 helpers): key guard matrix (revoked/expired/wrong-scope); changes pull for A never returns B rows (AT-16); batch ingest AT-09 (redelivery → `DUPLICATE`, single projection row), AT-15 (same eventId different payload → `REJECTED_PERMANENT`, original projection untouched), AT-21 (out-of-order + gap fill → checkpoint advances only contiguously); `Idempotency-Key` + envelope + `X-Request-Id` on all sync routes.
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` green.

---

## Outlet backend tasks

Existing scaffolding reused: worker env profile (`HQ_API_BASE_URL`, `HQ_OUTLET_KEY_ID/SECRET`, intervals, `OUTBOX_BATCH_SIZE`), `hqSyncConfig`, `contracts/sync-event-v1.schema.json`, outbox entities + invariant-checked writes, `menu_sync_state` (with `snapshot_id`), `catalog_items` (incl. `hq_item_version`, `applied_revision`), grace enforcement in `sales.service.ts`, `worker-main.ts` queue-name constants.

### O1 — Dispatcher state machine + attempt/audit tables
> Commit: `feat(outlet-backend): add outbox leasing, retries, and attempt logging`

- Migration `1730000000000-outlet-phase3-sync.ts`: `sync_attempt_logs` (§6.2) + `outlet_audit_logs` (id, actor_type, actor_id, action, entity_id, metadata jsonb, occurred_at). Entities registered.
- `OutboxRepository` extensions: `leaseDueBatch(now, batchSize, leaseMs)` (`FOR UPDATE SKIP LOCKED`, status `PENDING|RETRY` and `next_attempt_at` due, sets `lease_until` + transitions in-lease), `markDelivered(id)`, `markRetry(id, lastError, backoff)` — capped exponential backoff with jitter honoring `Retry-After`, `markQuarantined(id, lastError)`, `expireLeases(now)` (stalled work reverts to eligible — §8.6 G), `appendAttemptLog(...)` per send attempt (status_code, duration_ms, error_code; never secrets).
- Unit specs: lease exclusivity under contention, backoff caps/jitter bounds, lease expiry revert, quarantine terminality.
- Gates: lint/test; migration run/revert/run against compose `outlet-a-db` (`127.0.0.1:15433`).

### O2 — Typed HQ machine client (Kubb)
> Commit: `feat(outlet-backend): add typed HQ sync machine client`

- Copy `hq-backend/openapi/openapi.json` → `src/contracts/hq.openapi.json`; pinned `kubb.config.ts` filtered to the `sync` OpenAPI tag (pluginTs/pluginZod/pluginAxios `returnType: 'data'`, `baseURL` from `hqSyncConfig.hqApiBaseUrl`), `pnpm generate:api` script; output `src/modules/sync/clients/generated/` (build output, never hand-edited).
- `HqSyncClient` provider wrapping the generated client: request interceptor injects `Authorization: OutletKey <keyId>.<secret>` + `X-Request-Id`; batch push mints one `Idempotency-Key` per logical batch attempt (stable across transport retries of the same bytes, §8.5); every response parsed with the generated Zod schemas before use (§8.3); axios timeout ~10s; **secret never logged**.
- Unit specs with a mocked axios adapter: header injection, zod rejection of malformed HQ replies, batch-key stability across a network retry.
- Gates: lint/test + `pnpm generate:api` clean.

### O3 — Menu pull + snapshot apply
> Commit: `feat(outlet-backend): add menu pull and snapshot apply`

- `modules/sync/services/menu-pull.service.ts`: fetch changes after `menu_sync_state.last_applied_revision`; verify `outletId === outlet_identity.outlet_id` (§8.3); apply the whole batch in **one local transaction**: `UPSERT` → upsert `catalog_items` by `menu_item_id` (price/name/… + `hq_item_version`, `applied_revision`); `REMOVE` → `active = false` (row kept — inventory FK + history); duplicate/lower revision → no-op; then set `last_applied_revision = nextRevision`, `last_sync_at = now()`. Checkpoint advances only after writes commit (AT-13); HTTP failure leaves it untouched.
- Gap handling: response `snapshotRequired` or detected non-contiguity → `GET /sync/v1/menu/snapshot` → single atomic transaction: upsert snapshot items, mark local items absent from the snapshot `active = false`, set `last_applied_revision = snapshotRevision`, `snapshot_id = snapshotId`. Never infer removal from a missing page (§8.3).
- Unit/integration specs (real PG): apply atomicity via injected failure (nothing committed, checkpoint unchanged, safe retry — AT-13); empty batch no-op; re-apply idempotent; REMOVE blocks new sales (AT-12 leg); snapshot replaces and tombstones.
- Gates: lint/test (+ e2e where DB-dependent).

### O4 — BullMQ dispatcher + delivery workers
> Commit: `feat(outlet-backend): add outbox dispatch and delivery workers`

- Deps: `bullmq` (pinned). `src/modules/sync/processors/`: `outbox-sweep.processor` (repeatable job every `OUTBOX_SWEEP_INTERVAL_MS`): `expireLeases` → `leaseDueBatch` → enqueue **event IDs only** to `sync-delivery`; `sync-delivery.processor`: loads durable rows, groups up to `OUTBOX_BATCH_SIZE` / 1 MiB (§8.5), pushes via `HqSyncClient`; per-event results: `ACCEPTED` or `DUPLICATE` → `markDelivered`; `RETRYABLE_ERROR` or batch-level 408/425/429/5xx/timeout/network → `markRetry` (honor `Retry-After`); `REJECTED_PERMANENT` → `markQuarantined` + error log + `outlet_audit_logs` row (operator alert). `menu-pull.processor` (repeatable every `MENU_PULL_INTERVAL_MS`) runs `MenuPullService`.
- `worker-main.ts`: register the four queues' workers + repeatable schedulers (distributed singleton lock per §13), keep the heartbeat log, close BullMQ workers/queues on SIGTERM/SIGINT. Redis/BullMQ unavailability logs and retries — never affects the sale path (AT-10: sale commits with Redis down; sweeper resumes).
- Unit specs: dispatcher state transitions (delivered only after HQ ack — §8.6 "never mark delivered before HQ ack"), batch splitting, quarantine path, sweeper recovery after lease expiry.
- Gates: lint/test.

### O5 — Checkpoint reconciliation + heartbeat
> Commit: `feat(outlet-backend): add sync reconciliation and heartbeat`

- `sync-reconcile.processor` (repeatable, hourly default): `GET /sync/v1/checkpoint` → compare HQ `highestContiguousSequence`/`missingRanges` with local outbox → re-lease (make eligible) any delivered-or-pending event inside a missing range → logged reconciliation summary (§8.7; never fabricates events).
- `heartbeat.processor` (repeatable every `HEARTBEAT_INTERVAL_MS`): `POST /sync/v1/heartbeat` with local `{ appliedMenuRevision, pendingOutboxCount, quarantinedCount, oldestPendingAt }`; failure is non-fatal.
- Unit specs: missing-range re-lease selection, heartbeat payload from outbox/menu_sync_state reads.
- Gates: lint/test.

### O6 — Emergency grace override + quarantine replay
> Commit: `feat(outlet-backend): add audited offline-grace emergency override`

- New permission `sync.override` (granted to `OUTLET_MANAGER` only) + `sales.service.ts` grace check reads an effective expiry `max(last_sync_at + OFFLINE_GRACE_HOURS, grace_overridden_until)`. Seed updated: add the permission to the manager role.
- `POST /sync/grace-override` (`sync.override`): `ExtendGraceRequest { hours: int 1..72, reason: string 10..500 }` → one transaction: set `menu_sync_state.grace_overridden_until = now() + hours` (column added in O1 migration), append `outlet_audit_logs` row (actor, reason, hours) — §8.8 "privileged, audited".
- `POST /sync/outbox/:eventId/replay` (`sync.override`): re-arms a `QUARANTINED` row to `PENDING` after operator review (manual repair workflow, §8.5) + audit row.
- `GET /sync/status` extended: `grace: { hours, expiresAt (effective), expired, override: { active, until, reason, overriddenBy } | null }`, `outbox.lastErrorSample` for quarantined rows.
- Unit specs: override extends effective expiry; expiry of the override itself; cashier 403 (AT-17 flavor); quarantine replay transitions.
- Gates: lint/test + `openapi:export`.

### O7 — Outlet sync e2e suite
> Commit: `test(outlet-backend): verify menu apply atomicity and outbox delivery`

- E2e (real Postgres/Redis): AT-13 (kill apply mid-transaction via fault hook or SQL abort → checkpoint unchanged → retry succeeds); AT-10 (stop `outlet-a-redis` → POS sale still commits → restart Redis → sweeper delivers backlog); dispatcher delivery against a stubbed HQ (node http stub asserting OutletKey header + per-event ack handling); grace override flow (backdate `last_sync_at` 73h → 503 → override → sale succeeds).
- Gates: `pnpm lint && pnpm test && pnpm test:e2e` green.

---

## Frontend tasks

### F1 — outlet-frontend: contract refresh + override/replay controls
> Commit: `feat(outlet-frontend): add manager offline-grace override control`

- Copy refreshed `outlet.openapi.json` → `src/api/contracts/`; `pnpm generate:api`; no hand edits.
- Sync banner (already polling `/sync/status`): render effective grace expiry + active override (reason/actor); manager-only "Extend grace" dialog (hours + reason, Zod-validated, `error.code` surfacing) calling `POST /sync/grace-override`; quarantined-event count with manager-only replay action (`POST /sync/outbox/:eventId/replay`) behind a confirm step. Non-blocking as before.
- Gates: `pnpm generate:api` no-diff, `pnpm lint && pnpm build && pnpm check`.

### F2 — hq-frontend: contract refresh only
> Commit: `chore(hq-frontend): refresh API contract for HQ sync endpoints`

- Copy refreshed `hq.openapi.json` → contracts, regenerate; no UI this phase (sync-health dashboard is Phase 4). Keeps generated clients non-stale (root AGENTS §4.1).
- Gates: `pnpm generate:api` no-diff, `pnpm lint && pnpm build && pnpm check`.

---

## V — Environment wiring + end-to-end verification

### V1 — Dev key provisioning loop
> Commit: `feat: wire outlet key provisioning into dev compose stack`

- HQ seed extension (`SEED_ISSUE_OUTLET_KEYS=1`, default off): issues a real scoped key for each seeded outlet through `ApiKeysService`, printing `keyId.secret` **once** to the operator (seed runs server-side; pepper from env) — makes the compose loop self-contained.
- Root `.env.example` documents: run HQ seed with the flag → paste into `OUTLET_A_HQ_KEY_ID/SECRET` → `docker compose up -d outlet-a-worker`.
- Gates: manual run of the documented loop.

### V2 — End-to-end verification + docs
> Commit: `docs: document Phase 3 synchronization and verification`

1. Full `docker compose up -d` + seeds + key provisioning (V1 loop).
2. **Menu flow (AT-01/AT-02/AT-12):** HQ UI edits burger price / unassigns from A → within `MENU_PULL_INTERVAL_MS` outlet `/menu` shows the new effective price; unassigned item disappears (sale denied `ITEM_NOT_ASSIGNED`); outlet B override differs from A default; existing receipts unchanged (AT-19 holds).
3. **Sale flow (AT-03 sync leg):** POS sale → outbox `PENDING` → delivery worker pushes → SQL on `hq-db`: `sync_inbox_events`, `hq_sales`, `hq_sale_items` rows with snapshot prices; outlet outbox row `DELIVERED`; `/sync/status` clean.
4. **Outage drill (AT-10/AT-11):** `docker stop fnb-platform-hq-api-1` → POS sales keep committing (grace window), sync banner shows growing backlog → `docker start` → backlog drains within minutes; receipts sequential, no duplicates at HQ.
5. **Crash/replay drills (AT-09/AT-13/AT-14/AT-15/AT-21):** re-post an already-delivered event batch directly (curl with the outlet key) → all `DUPLICATE`, single projection; tamper one payload → `REJECTED_PERMANENT` + `EVENT_ID_CONFLICT` audit; delete early `outlet_catalog_changes` rows on HQ + reset outlet checkpoint → worker detects gap → snapshot applied atomically; out-of-order push (curl two batches swapped) → checkpoint advances only contiguously.
6. **Security (AT-16/AT-17):** outlet A key against B-scoped expectations returns only A data; cashier token on `POST /sync/grace-override` → 403; `hq-frontend` cannot reach `/sync/v1/*` (no CORS for browser, no bearer acceptance).
7. **Grace override (AT-11 leg):** backdate `menu_sync_state.last_sync_at` 73h → sale 503 → manager override via UI → sale succeeds + `outlet_audit_logs` row; banner shows the override.
8. **AT-22 drill (best effort):** `pg_dump`/restore outlet DB to a pre-sale state → replay events → HQ dedups; receipt counter/outbox consistent with the backup.
9. curl spot-checks: envelope + `X-Request-Id` on sync routes; 401 bad key; 403 wrong scope; 413 oversized batch; 429 throttling behavior sane.
10. Update root `README.md` (Phase 3 section, key-provisioning loop, outage drill results) and both backend READMEs.

---

## Definition of done (Phase 3)

- AT-01/02/09/10/11/12/13/14/15/16/21 pass (e2e + drills); AT-22 drill documented.
- `openapi:export` artifacts and both frontends' generated clients current (`generate:api` is a no-op diff).
- No committed sale lacks its outbox row; no `DELIVERED` without an HQ ack row; exactly-once HQ business effects under duplicate pushes (SQL-verified).
- Outlet key secret exists only in backend env/logs-free paths; `X-Request-Id` everywhere; sale transaction still contains zero queue/HTTP calls.
- Money stays decimal strings end to end; `hq_sales` totals match outlet sale totals exactly.
