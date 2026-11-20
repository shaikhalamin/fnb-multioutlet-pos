# AGENTS.md — outlet-backend

Independent Outlet NestJS application (API entrypoint `src/main.ts` + sync worker entrypoint `src/worker-main.ts`).
Read the root [../AGENTS.md](../AGENTS.md) first — all universal wire-format, DTO/Swagger, and error rules apply here.
Source of truth: [../fnb_multi_outlet_prd.md](../fnb_multi_outlet_prd.md) ("PRD").

## Mission

The outlet owns, canonically: local sales, inventory balances and movements, receipt allocation, menu cache, and the transactional outbox. It can complete valid sales during HQ/network outages (within the offline grace policy) and pushes/pulls all synchronization itself (PRD §1, §8).

## Commands

```bash
pnpm build            # nest build
pnpm start:dev        # API in watch mode
pnpm start:worker     # sync worker entrypoint (dist/worker-main.js)
pnpm lint             # oxlint (type-aware)
pnpm test             # Vitest unit/integration
pnpm test:e2e         # Vitest e2e (+ test/contract for sync event v1)
pnpm migration:run    # TypeORM migrations (single controlled job — never per API replica)
pnpm openapi:export   # rebuild openapi/openapi.json → consumed by outlet-frontend Kubb
```

## Module map (PRD §5, §18)

`auth`, `users`, `menu-cache`, `inventory`, `sales`, `receipts`, `outbox`, `sync` (with `services/`, `repositories/`, `processors/`, `clients/`), `local-reporting` — under `src/modules/<name>/`. Entities in `src/database/entities/` matching PRD §6.2 tables exactly. Queues: `menu-pull`, `outbox-dispatch`, `sync-delivery`, `sync-reconcile`.

## Strict rules

### Endpoints and DTOs (PRD §7.3)

1. Human routes exactly as listed: `/auth/*`, `GET /menu`, `GET /inventory`, `POST /inventory/adjustments`, `POST /sales`, `GET /sales/:id`, `GET /sales`, `GET /sync/status`. Permissions: `menu.read`, `inventory.read`, `inventory.adjust`, `sales.create`, `sales.read`, `sync.read` — `@ApiSecurity('bearer-jwt')`.
2. DTO names per PRD §7.1 (`CreateSaleRequest`, `SaleResponse`, …). `CreateSaleRequest` contains **only** `items: [{ menuItemId, quantity }]` — any price/total/receipt/outletId field in it is a defect. Response DTOs include the immutable snapshots the sale captured.
3. Outlet identity comes from server-side identity config/claims — never from request JSON (PRD §3, §15).

### The sale transaction (PRD FR-06, §8.6) — the most protected code in this repo

4. One PostgreSQL transaction, in this order: validate user + `sales.create` → canonicalize lines (merge duplicates by `menuItemId` **before** hashing/validating) → insert/lock idempotency row (same key + different request hash ⇒ `409 IDEMPOTENCY_KEY_REUSED`; existing success ⇒ return the stored response) → load active catalog rows and resolve persisted effective prices → lock inventory rows **in sorted menuItemId order** (`FOR UPDATE`) → verify stock, update balances → append stock movements → lock + increment `receipt_counters` → insert sale + lines with captured name/SKU/price/revision → lock `outbox_counters`, allocate `sequenceNo`, insert `sale.completed` outbox row → persist idempotency response → COMMIT.
5. Any error rolls back everything. BullMQ enqueue is **not** part of this transaction — the dispatcher picks the outbox up asynchronously.
6. Concurrency safety comes from DB constraints, row locks, and deterministic lock order — never a JS mutex. Atomic conditional updates (`UPDATE … WHERE quantity_on_hand >= $q`) are the preferred contention pattern.
7. Outcomes to preserve (AT-04/05/07/08): insufficient stock ⇒ `409 INSUFFICIENT_STOCK` with `{menuItemId, requestedQuantity, availableQuantity}` and zero side effects; concurrent last-unit sales ⇒ exactly one commits; duplicate POST with same key ⇒ same sale/receipt, no second deduction or event.

### Catalog sync — pull (PRD FR-03, §8.3)

8. Apply a full change batch and update `menu_sync_state.last_applied_revision` in **one** local transaction; never advance the checkpoint before writes commit; a failed HTTP call leaves the checkpoint untouched.
9. Revisions ≤ local applied revision are a no-op. An empty change response never deletes local data. Gaps/truncated history ⇒ fetch a consistent snapshot (staging table → atomic swap, mark absent items inactive, set revision to `snapshotRevision`), never infer removal from a missing page.
10. `REMOVE`/deactivation blocks new sales only after it is applied locally (offline grace policy, PRD §8.8).

### Outbox → HQ push (PRD FR-07, §8.4–§8.7)

11. Every committed sale emits exactly one immutable `sale.completed` event matching `src/contracts/sync-event-v1.schema.json`: `eventId = outbox row id`, per-outlet contiguous `sequenceNo` allocated in the sale transaction, `sum(subtotal) = totalMinor`, `quantity × unitPrice = subtotal`.
12. Dispatcher: periodic scanner leases due rows (`FOR UPDATE SKIP LOCKED`) → enqueue only event IDs to BullMQ → processor loads the durable row and sends an authenticated HTTPS batch. Mark `DELIVERED` only on HQ `ACCEPTED` or hash-identical `DUPLICATE`; on timeout/429/5xx set `RETRY` with capped exponential backoff + jitter (honor `Retry-After`); on permanent conflict set `QUARANTINED` and alert — **never delete**. Never mark delivered before HQ ack. Expired leases return to eligible state; the periodic scanner is mandatory even when BullMQ scheduling works.
13. The HQ machine client lives under `src/modules/sync/clients/`, reads the key from server-side env (`HQ_OUTLET_KEY_ID`/`HQ_OUTLET_KEY_SECRET`) via a request interceptor, and is **backend-only** — the key never reaches a browser bundle, query string, or log (PRD §7.4, §9.2).
14. Reconciliation: compare HQ checkpoint against local outbox; replay only missing events; highest **contiguous** sequence, not `MAX(sequenceNo)` (PRD §8.7).

### Invariants

15. `sale.status = COMPLETED` is separate from `sync_status = PENDING | DELIVERED | QUARANTINED` — sync is not a second completion step.
16. Inventory is per-outlet and per-assigned-item; movements are append-only with reason/actor/request ID; `CHECK (quantity_on_hand >= 0)` and friends stay in the schema (PRD §6.2).
17. Config via `ConfigService<Env, true>` only; `APP_ENTRYPOINT=api|worker` selects the validation profile — the worker profile requires the HQ key config and never holds JWT signing secrets (PRD §14.1).
