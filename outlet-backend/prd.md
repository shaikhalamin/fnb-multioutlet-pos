# PRD — Outlet Backend (`outlet-backend`)

**Parent PRD:** [`../fnb_multi_outlet_prd.md`](../fnb_multi_outlet_prd.md) (Multi-Outlet F&B Management Platform, V1.0)
**Scope:** V1.0 core responsibilities only — optional / V1.1 items (HQ stock snapshots, optional inventory push to HQ, optional heartbeat endpoint) are excluded.
**Technology:** TypeScript, Node.js, NestJS (Express adapter), TypeORM, PostgreSQL, Redis/BullMQ, Zod, OpenAPI/Swagger, Docker

---

## 1. Overview and boundaries

`outlet-backend` is the independent Outlet NestJS application (HTTP entry `main.ts`, worker entry `worker-main.ts`), deployed **once per outlet site** with its own PostgreSQL database, Redis instance, API, and sync worker. Multiple outlet API/worker replicas may share that outlet database.

The outlet is the **operational authority**: sales, inventory balances, movements, receipt allocation, and the unsent outbox are canonical here. An outlet can complete valid sales using its last successfully synchronized catalog and local inventory even during a temporary HQ/network outage, subject to the offline policy below.

**Boundary rules that govern this service:**

- Outlet business transactions must **never** depend on an HQ request. No container depends on HQ API reachability to complete an outlet sale.
- The outlet sync worker initiates *all* HQ synchronization calls: it pulls menu changes and pushes events. HQ never connects to the outlet database.
- The outlet never stores HQ-wide master catalog beyond items assigned to it.
- Outlet users/roles/tokens are entirely local — never HQ tokens, never cross-replicated credentials.
- The HQ outlet key (base URL + `keyId`/`secret`) is a server-side machine secret stored in the outlet's own `hq_connection` table — written by the setup wizard (or the audited `PUT /sync/hq-connection` rotation) and read **only** by the worker; never in environment variables, query strings, log messages, or frontend assets.

**Core reliability contract:** local sale + inventory movement + receipt allocation + outbox record commit **atomically** in the outlet PostgreSQL database; outbound delivery retries are expected; HQ achieves exactly-once business effects via unique keys — the outlet must never assume exactly-once transport.

## 2. Functional responsibilities

| FR | Responsibility (outlet side) |
|---|---|
| FR-03 | Catalog distribution: pull revisioned changes for the outlet bound to its key; persist a revisioned, read-optimized local catalog; apply a complete change batch and update the local checkpoint in one outlet DB transaction; `REMOVE`/deactivation prevents all *new* local sales after it is applied; an empty change response never deletes local catalog data. |
| FR-04 | Inventory: one stock balance per assigned menu item and an append-only stock movement ledger; restocks/adjustments record reason, actor and request ID; selling quantity `q` requires `q > 0` and sufficient local stock; inventory changes never affect another outlet; atomic DB updates enforce nonnegative balances. |
| FR-05 | Sales and receipts: multi-item sales with positive quantities; backend resolves current local effective prices, computes line subtotals and total, and captures immutable price/name/SKU snapshot, catalog revision and currency; backend generates outlet-scoped receipts (`A-000001`, `A-000002`, …); no user-provided receipt number or total is accepted; client-supplied **sale idempotency key** permits safe retries after timeouts. |
| FR-06 | Transaction integrity and concurrency: each sale completes in one local PostgreSQL transaction (see §6.1); any error rolls back everything; BullMQ enqueue is **not** part of this transaction. |
| FR-07 | Durable synchronization: outbox dispatcher publishes eligible event IDs to BullMQ; sync workers read durable DB records, authenticate HTTPS requests to HQ, retry safely; transient failures never discard an event; permanent failures enter a quarantined state for operator review. |
| FR-09 | Outlet auth: own `auth/login`, `auth/refresh`, `auth/logout`; short-lived access JWT + rotating refresh token; refresh reuse revokes the session family and is auditable; machine sync uses the scoped outlet API key, not a human JWT. |
| FR-10 | Observability: health checks, structured logs, local `/sync/status` (menu revision, last sync, pending/dead events, HQ pairing summary). |
| FR-11 | First-run provisioning: the setup wizard saves the HQ-issued outlet ID + code and creates the first admin in one transaction (`POST /setup/identity`), then validates the one-time HQ machine key live and stores the pairing (`POST /setup/hq-connection`); both endpoints are public only while unprovisioned and seal permanently; later key rotation goes through the audited `PUT /sync/hq-connection` (`sync.manage`) with the same live validation. |

**FR-06 acceptance:** two concurrent purchases of the last burger produce exactly one committed sale; a multi-item sale with any insufficient item creates zero movements, zero receipt increments and zero outbox messages; successful duplicate POST requests return the same sale and receipt without deducting stock again.

## 3. Outlet PostgreSQL schema (one database per outlet)

The outlet identity is provisioned once — through the setup wizard (UI pairing with HQ) or, for local development, a DB seed — and is checked against every worker event.

| Table | Important fields | Constraints and purpose |
|---|---|---|
| `outlet_identity` | `outlet_id`, `outlet_code`, `company_id` (nullable), `timezone` (nullable), `currency_code` (nullable) | Singleton configuration; written once at wizard provisioning (currency backfilled from the first menu pull). |
| `hq_connection` | `outlet_id` (FK → `outlet_identity`), `hq_base_url`, `key_id`, `key_secret`, `last_validated_at`, `updated_at` | Singleton HQ pairing (wizard / rotation); the worker's sole credential source — raw secret lives only here. |
| `outlet_users`, `outlet_roles`, `outlet_permissions`, `outlet_user_roles`, `outlet_role_permissions` | local identities/permissions | Outlet-only, not HQ tokens. |
| `outlet_refresh_sessions` | `id`, `user_id`, `family_id`, `jti`, `expires_at`, `revoked_at` | Refresh-JWT rotation and family invalidation, keyed on `jti`. |
| `catalog_items` | `menu_item_id`, `assignment_id`, `sku`, `name`, `description`, `category`, `effective_price_minor bigint`, `currency_code`, `active`, `hq_item_version`, `applied_revision` | Upsert by HQ ID; immutable identity, price/status updated by sync. |
| `menu_sync_state` | `outlet_id`, `last_applied_revision bigint`, `last_sync_at`, `snapshot_id` | Atomic checkpoint applied with menu data. |
| `inventory_balances` | `menu_item_id`, `quantity_on_hand bigint`, `version int`, `updated_at` | PK(menu_item_id); CHECK(quantity_on_hand >= 0); FK local catalog item. |
| `stock_movements` | `id`, `menu_item_id`, `delta_quantity bigint`, `reason`, `source_sale_id NULL`, `actor_id NULL`, `occurred_at` | Append-only audited stock ledger; movement delta can be signed. |
| `receipt_counters` | `outlet_id`, `next_number bigint`, `prefix` | One row; lock `FOR UPDATE`, increment in committed sale transaction; CHECK(next_number > 0). |
| `sales` | `id`, `outlet_id`, `receipt_number bigint`, `receipt_no`, `total_minor bigint`, `currency_code`, `status`, `catalog_revision`, `sold_at`, `created_by` | UNIQUE(outlet_id,receipt_number), UNIQUE(outlet_id,receipt_no); server-computed totals. |
| `sale_items` | `id`, `sale_id`, `menu_item_id`, `name_snapshot`, `sku_snapshot`, `quantity`, `unit_price_minor bigint`, `subtotal_minor bigint`, `catalog_revision` | UNIQUE(sale_id,menu_item_id) after merging duplicate request lines; immutable history. |
| `sale_idempotency_keys` | `id`, `outlet_id`, `key`, `request_sha256`, `sale_id`, `response_json`, `created_at`, `expires_at` | UNIQUE(outlet_id,key); same key + different payload => 409; keep beyond client retry horizon. |
| `outbox_counters` | `outlet_id`, `next_sequence bigint` | Protected per-outlet event sequence (transactional, no duplicate sequence). |
| `outbox_events` | `id`, `outlet_id`, `sequence_no`, `event_type`, `schema_version`, `payload jsonb`, `payload_sha256`, `status`, `attempts`, `next_attempt_at`, `lease_until`, `published_at`, `last_error` | UNIQUE(outlet_id,sequence_no); durable delivery source, `event_id=id`. |
| `sync_attempt_logs` | `id`, `outbox_event_id`, `attempt_at`, `status_code`, `duration_ms`, `error_code` | Debugging and retention-limited audit. |

**Outlet-side SQL protections:**

```sql
ALTER TABLE inventory_balances
  ADD CONSTRAINT inventory_nonnegative CHECK (quantity_on_hand >= 0);
ALTER TABLE sale_items
  ADD CONSTRAINT positive_line_quantity CHECK (quantity > 0),
  ADD CONSTRAINT nonnegative_line_price CHECK (unit_price_minor >= 0),
  ADD CONSTRAINT nonnegative_line_subtotal CHECK (subtotal_minor >= 0);
CREATE UNIQUE INDEX uq_outlet_event_seq ON outbox_events(outlet_id, sequence_no);
CREATE INDEX idx_outbox_due ON outbox_events(status, next_attempt_at)
  WHERE status IN ('PENDING', 'RETRY');
```

Additional indexes: `stock_movements(menu_item_id,occurred_at DESC)`, `sales(sold_at DESC)`. Use real migrations, never `synchronize: true`, in all environments.

**Entity rules:** no cross-database FK to HQ is possible — carry UUID references and validate according to authority. FK local `sale_items.sale_id` to local `sales`. Amounts stored as `bigint`, manipulated as `bigint` in TypeScript, serialized as canonical decimal strings; reject unsafe/out-of-range values in DTOs.

## 4. HTTP API surface (outlet human JWT)

Base URL: `https://outlet-a.example.local/api/v1` (site deployment may differ). Swagger at `/api/docs` in development/admin-restricted environments; machine-readable `/openapi.json` artifact in CI. JSON content type; UTC ISO 8601 timestamps; UUID IDs; integer quantities; money strings `^[0-9]+$` bounded to `bigint`. Human endpoints use `Authorization: Bearer <access_jwt>`. Every write accepts/returns `X-Request-Id`; client-created sale requires `Idempotency-Key`. Stable error codes; correct 401/403/404/409/422/429/503; never leak cross-scope resources. The outlet ID of a cashier is taken from server-side identity configuration/claims, **not** trusted from request JSON.

**Response envelopes:**

```ts
type ApiSuccess<T> = {
  data: T;
  meta?: { requestId: string; timestamp: string; nextCursor?: string };
};
type ApiError = {
  error: {
    code: string;                 // e.g. INSUFFICIENT_STOCK
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};
type MoneyMinor = string;          // regex ^(0|[1-9][0-9]*)$
```

**Schema naming:** `CreateSaleRequest`, `SaleResponse`, `CatalogChangesResponse`, `EventBatchRequest`, `EventBatchResponse` (shared sync contract).

### 4.1 Outlet endpoints

| Method | Route | Permissions | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | Public with rate limit | Outlet login. |
| `POST` | `/auth/refresh` | Refresh cookie/session | Rotate outlet refresh. |
| `POST` | `/auth/logout` | Authenticated | Revoke. |
| `GET` | `/setup/status` | Public | Terminal provisioning state (drives the setup wizard). |
| `POST` | `/setup/identity` | Public while unprovisioned, then sealed | Wizard step 1: save the HQ-issued outlet ID + code and create the first admin (one transaction). |
| `POST` | `/setup/hq-connection` | Public while unpaired, then sealed | Wizard step 2: validate the HQ machine key live and store the pairing. |
| `GET` | `/menu` | `menu.read` | Active, locally assigned menu with effective prices only. |
| `GET` | `/inventory` | `inventory.read` | Local balances. |
| `POST` | `/inventory/adjustments` | `inventory.adjust` | Audited local restock/write-off. |
| `POST` | `/sales` | `sales.create` | Multi-line atomic sale, idempotent. |
| `GET` | `/sales/:id` | `sales.read` | View receipt and historical lines. |
| `GET` | `/sales?from=&to=&cursor=` | `sales.read` | Local sale history. |
| `GET` | `/sync/status` | `sync.read` | Menu revision, last sync, pending/dead events, HQ pairing summary (key ID only). |
| `PUT` | `/sync/hq-connection` | `sync.manage` | Rotate the stored HQ machine key (validated live before saving). |

**Outlet menu response (after applying HQ revision 42):**

```json
{
  "data": [
    {
      "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab",
      "sku": "BURGER-01",
      "name": "Chicken Burger",
      "category": "Burgers",
      "unitPriceMinor": "1200",
      "currencyCode": "USD",
      "availableQuantity": 30
    }
  ],
  "meta": { "catalogRevision": "42", "lastCatalogSyncAt": "2026-11-20T04:00:00Z" }
}
```

**Create sale (client does not submit price, total, receipt, or outlet ID):**

```http
POST /api/v1/sales
Authorization: Bearer <outlet-jwt>
Idempotency-Key: pos-register-2-4af2e801-6351-4bd5-abf6-536c02b918c4
Content-Type: application/json

{
  "items": [
    { "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab", "quantity": 2 },
    { "menuItemId": "c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4", "quantity": 1 }
  ]
}
```

```json
{
  "data": {
    "id": "0a44e56a-628e-492a-81e0-83f4a4d68f76",
    "receiptNo": "B-000001",
    "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420",
    "status": "COMPLETED",
    "currencyCode": "USD",
    "items": [
      { "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab", "name": "Chicken Burger", "quantity": 2, "unitPriceMinor": "1200", "subtotalMinor": "2400" },
      { "menuItemId": "c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4", "name": "Pizza", "quantity": 1, "unitPriceMinor": "1500", "subtotalMinor": "1500" }
    ],
    "totalMinor": "3900",
    "catalogRevision": "42",
    "soldAt": "2026-11-20T04:02:03Z",
    "syncStatus": "PENDING"
  }
}
```

**Insufficient stock:** HTTP `409` with `error.code = "INSUFFICIENT_STOCK"` and details `{menuItemId, requestedQuantity, availableQuantity}`; the entire transaction rolls back. `409 IDEMPOTENCY_KEY_REUSED` if the same key is posted with a different canonical request payload. Validate at most e.g. 100 distinct items, max quantity per line, no unknown keys; duplicate lines are normalized by ID before hashing and validating (V1: normalize consistently).

## 5. Catalog pull (HQ → outlet)

The worker consumes the HQ sync APIs using the outlet key:

| Method | Route | Key scope | Behavior |
|---|---|---|---|
| `GET` | `/sync/v1/menu/changes?afterRevision=42&limit=500` | `menu.pull` | Fetch only changes for the authenticated outlet, ascending revision. |
| `GET` | `/sync/v1/menu/snapshot` | `menu.pull` | Consistent full catalog snapshot for bootstrap/gap recovery. |

**Pull algorithm:** query `revision > local.last_applied_revision`, ascending; require contiguous revisions for the returned page (unless the snapshot protocol explicitly handles compaction). Validate the response with the versioned contract and verify the outlet ID. Upsert/disable the local catalog in a *single local transaction*, then set `last_applied_revision = nextRevision`. Never advance the checkpoint before writes commit. If an HTTP request fails, leave the checkpoint untouched. A repeated response must apply safely; a revision ≤ local applied revision is a no-op. If history is truncated or a gap is detected, fetch a consistent snapshot and replace catalog state atomically; **never infer removal from a missing page**.

**Snapshot application:** the snapshot response includes `snapshotId`, `snapshotRevision`, pages/cursor, and a stable view for the snapshot lifetime. Download all pages to a staging table; after complete verification atomically swap/merge staging, mark absent items inactive, and set the local revision to `snapshotRevision`. If the snapshot expires mid-download, restart. Then resume changes **after** that exact revision; updates concurrent with the snapshot are not lost.

## 6. Sales transaction and outbox (outlet → HQ)

### 6.1 Local sale transaction (one QueryRunner/transaction manager)

```text
 1. Validate authenticated local outlet user + sale.create permission.
 2. Canonicalize request lines and hash request with idempotency key.
 3. Insert/lock idempotency row; if successful prior result exists, return it.
    If same key has a different request hash, return 409.
 4. Load active local catalog rows and resolve persisted effective prices.
 5. Lock inventory rows in sorted menuItemId order (FOR UPDATE).
 6. Verify every item has sufficient stock and update balances atomically.
 7. Insert stock movements for each line.
 8. Lock receipt_counter row (FOR UPDATE), allocate number, increment counter.
 9. Insert sale and sale_items with captured immutable names/prices.
10. Lock outbox_counter, allocate event sequence; insert sale.completed outbox.
11. Persist idempotency response and COMMIT.
12. Return the committed sale; dispatcher picks up outbox asynchronously.
```

For high contention, use atomic conditional stock updates (`UPDATE ... SET quantity_on_hand = quantity_on_hand - $q WHERE menu_item_id = $id AND quantity_on_hand >= $q RETURNING ...`) within the same transaction; still use a **consistent per-item order** across all writes. Database uniqueness constraints and row locks, not a JavaScript mutex, are the final concurrency controls. Failed transaction retries must reuse the same client idempotency key. Lock rows in deterministic item-ID order. Never trust client-submitted prices, totals, receipts, or sale timestamps — the outlet backend generates the authoritative `soldAt`.

### 6.2 `sale.completed` outbox event schema v1

Each committed sale emits one immutable `sale.completed` event; `event_id = outbox row id`, `sequenceNo` originates from the same outlet DB transaction as the outbox row.

```json
{
  "eventId": "3feeb5c0-53fa-476e-a758-3040a3529041",
  "eventType": "sale.completed",
  "schemaVersion": 1,
  "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420",
  "sequenceNo": "108",
  "occurredAt": "2026-11-20T04:02:03Z",
  "data": {
    "saleId": "0a44e56a-628e-492a-81e0-83f4a4d68f76",
    "receiptNo": "B-000001",
    "catalogRevision": "42",
    "currencyCode": "USD",
    "status": "COMPLETED",
    "soldAt": "2026-11-20T04:02:03Z",
    "totalMinor": "3900",
    "items": [
      {
        "saleItemId": "64750166-32a4-46f8-9285-f536f5b03213",
        "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab",
        "nameSnapshot": "Chicken Burger",
        "skuSnapshot": "BURGER-01",
        "quantity": 2,
        "unitPriceMinor": "1200",
        "subtotalMinor": "2400"
      },
      {
        "saleItemId": "b7d5d798-daa0-4c52-a675-6d58a9b69f6b",
        "menuItemId": "c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4",
        "nameSnapshot": "Pizza",
        "skuSnapshot": "PIZZA-01",
        "quantity": 1,
        "unitPriceMinor": "1500",
        "subtotalMinor": "1500"
      }
    ]
  }
}
```

**Integrity invariants:** `sum(item.subtotalMinor) = totalMinor`; `quantity * unitPriceMinor = subtotalMinor`; the event's outlet ID equals the authenticated key outlet; the sale is immutable and exactly one logical receipt belongs to `(outletId, receiptNo)`. Schema upgrades use additive changes and explicit supported versions; unknown required versions received from HQ responses are quarantined, never silently ignored.

### 6.3 Push batch and per-event acknowledgement

```http
POST /api/v1/sync/v1/events/batch
Authorization: OutletKey ok_live_123.<redacted-secret>
Idempotency-Key: 047bfdb5-727a-47eb-970a-03a038c11b92
Content-Type: application/json

{ "batchId": "047bfdb5-727a-47eb-970a-03a038c11b92", "events": [ /* event above */ ] }
```

```json
{
  "data": {
    "batchId": "047bfdb5-727a-47eb-970a-03a038c11b92",
    "results": [
      {
        "eventId": "3feeb5c0-53fa-476e-a758-3040a3529041",
        "status": "ACCEPTED",
        "retryable": false,
        "acknowledgedAt": "2026-11-20T04:02:10Z"
      }
    ],
    "highestContiguousSequence": "108"
  }
}
```

Outcomes handled by the worker: `ACCEPTED`, `DUPLICATE` (same canonical payload hash — terminal success), `RETRYABLE_ERROR` (not acknowledged; retry that event), `REJECTED_PERMANENT` (quarantined locally, never deleted; manual repair/replay workflow required). HTTP 200 may include mixed event statuses; HTTP 401/403/413/429/5xx applies to the batch/request and is handled independently.

**Batch idempotency:** preserve the same `batchId` and `Idempotency-Key` when retrying the *same bytes*. Event-level identity remains the ultimate deduplication key even if the worker later re-batches unacknowledged events. Respect batch limits (e.g. 100 events / 1 MiB) and split large backlogs.

### 6.4 Outlet dispatcher / worker algorithm

```text
A. Periodic scanner leases due outbox rows with FOR UPDATE SKIP LOCKED.
B. Enqueue only event IDs to BullMQ; Redis jobs may be duplicated or lost.
C. Processor loads the durable event and attempts an authenticated HTTPS batch send.
D. Mark each ACCEPTED or identical DUPLICATE as DELIVERED in the local DB.
E. For timeout/429/5xx, set RETRY with capped exponential backoff + jitter.
F. For permanent validation conflict, set QUARANTINED and alert the operator.
G. Lease expiry returns stalled work to eligible retry; the periodic scanner
   recovers after process/Redis crashes. Never mark delivered before the HQ ack.
```

### 6.5 Recovery, ordering, retention, reconciliation

- **Delivery:** at-least-once network delivery; deduplication is HQ's job — never advertise exactly-once HTTP transport.
- **Ordering:** all outbound events carry per-outlet contiguous `sequenceNo`; HQ may ingest out of order.
- **Retries:** bounded exponential backoff with jitter for 408/425/429/5xx/network faults; honor `Retry-After` when present; alert after a configurable age/attempt threshold. Avoid 401 infinite retries: refresh/rotate the machine key through a secure operator process.
- **Recovery:** the periodic outbox scanner is required even if BullMQ scheduling succeeds; expired leases revert; a crashed worker cannot make an event disappear.
- **Reconciliation:** the worker calls the HQ checkpoint, compares accepted sequences with the local outbox, and selectively replays missing events. A daily reconciliation job compares local completed sale count, totals, and receipt range to HQ projections for an agreed UTC/date window; alert on mismatch; never auto-insert fabricated sales.
- **Retention:** retain outbox delivered rows until reconciliation/archive policies guarantee safe replay; keep sales/receipt records per legal policy.
- **Status:** keep `sale.status=COMPLETED` separate from `sale.sync_status=PENDING|DELIVERED|QUARANTINED`; sync is not a second sale-completion step.
- **Bootstrapping:** a new terminal provisions itself through the setup wizard — paste the HQ-issued outlet ID + site code (creating the first admin in the same transaction), then paste the one-time machine key, which is validated live against HQ before the pairing is saved to `hq_connection`. The worker then performs a full catalog snapshot, staff provision inventory through the audited adjustment flow, and cashier sales begin.

## 7. Offline policy and critical consistency trade-off

**Unavoidable constraint:** while disconnected, the outlet cannot know that HQ just revoked an item or changed its price. The platform therefore cannot simultaneously guarantee unrestricted offline sales **and** immediate global enforcement of HQ changes.

**V1 policy:** the outlet may sell only locally active, last-synchronized assigned items while disconnected, for up to a configurable grace period (proposed 72 hours, `OFFLINE_GRACE_HOURS`); after expiry, block new sales until menu sync succeeds or a privileged, audited emergency override is applied. Every sale records its `catalogRevision` and local `soldAt`. A product removal takes effect locally once its `REMOVE` revision is applied. A business needing *immediate* HQ revocation must configure **online-only** sale authorization instead.

**Clock security:** do not depend solely on the outlet's wall clock for fraud detection; report drift, keep `created_at`/`received_at` and event sequence, and use NTP. The grace policy uses monotonic/last-success state where available, with restart-safe local timestamps and audit.

## 8. Authentication and RBAC

### 8.1 Human JWT sessions (outlet)

- `OUTLET_JWT_ISSUER`/`OUTLET_JWT_AUDIENCE`; own signing keys/key IDs; access token lifetime target **10–15 minutes**. Claims: `sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `scope`/role IDs, and the outlet ID for outlet tokens. Recheck user active status and permissions against server state or short-lived cache.
- Refresh token: signed refresh JWT (`OUTLET_JWT_REFRESH_SECRET`, distinct `jti` per issuance), rotated on each refresh, with every `jti` tracked server-side in the refresh-session table; browser holds it in an `HttpOnly`, `Secure`, suitable `SameSite` cookie with CSRF protections; avoid localStorage. `POST /auth/refresh` must serialize rotation or use compare-and-swap on the session row's rotation state; a stolen/reused old `jti` invalidates its refresh family.
- Passwords: Argon2id/bcrypt with strong parameters; login rate limits/lockout; audit log for sign-in, refresh reuse, and permission changes.
- Guards validate signed JWT **and** `iss`, `aud`, `exp`, `sub`, enabled account status, outlet scope, and permission on every protected route.

**Login response shape:**

```json
{
  "data": {
    "accessToken": "<signed-jwt>",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "user": {
      "id": "f5df2a66-119c-45e5-b797-fd31cfd93aa8",
      "roleCodes": ["OUTLET_CASHIER"],
      "permissions": ["menu.read", "sales.create", "sales.read"],
      "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420"
    }
  }
}
```

(Refresh token is set in an HTTP-only cookie, not returned in JSON.)

### 8.2 Machine sync identity

The worker uses `Authorization: OutletKey <keyId>.<secret>` with `menu.pull` and `events.push` scopes bound to this outlet only. The key comes from the `hq_connection` table (setup wizard / audited rotation route; re-read before every HQ call so rotation lands without a restart) — never from environment variables, frontend code, query strings, or logs. HQ derives `outletId` from the key record; a key minted for a different outlet is refused at pairing time. Require TLS (mTLS where available); short request timeouts; body size caps.

### 8.3 Outlet permission matrix

| Action | Outlet Manager | Cashier | Inventory Clerk |
|---|---|---|---|
| Read assigned local menu | Yes | Yes | Yes |
| Create local sale | Yes | Yes | No |
| Adjust local stock | Yes | No | Yes |
| Read local sales | Yes | Yes (scope-limited) | No |

No frontend route hiding is sufficient authorization; always enforce backend guards and ownership checks.

## 9. Validation and error handling

| Layer | Outlet rules |
|---|---|
| Controller | Nest DTO validation via global `ValidationPipe` (whitelist, forbid unknown properties, transformation); sanitize strings; max payload size; UUID/ISO/date validation. |
| Service | Business rules: assigned menu, price resolution, currency, stock, totals, outlet isolation. |
| Repository/DB | FK, UNIQUE, CHECK, transactions, row locks, index-backed queries. |
| Worker | Validate envelopes, versions, checksum, HTTP status + per-event ACK; retry safely. |

**Standard error codes used:** `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `ITEM_NOT_ASSIGNED`, `ITEM_INACTIVE`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_KEY_REUSED`, `RECEIPT_CONFLICT`, `MENU_SNAPSHOT_REQUIRED`, `SYNC_TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`.

**Sample error:**

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "One or more items are out of stock.",
    "details": {
      "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab",
      "requestedQuantity": 5,
      "availableQuantity": 2
    },
    "requestId": "req_79fe0b"
  }
}
```

## 10. Queues and operational design

- Separate outlet Redis namespace/instance. Outlet queues: `menu-pull`, `outbox-dispatch`, `sync-delivery`, `sync-reconcile`. Jobs include IDs and look up DB records; queue payloads contain **no** bearer credentials or full PII-heavy sale details. Configure concurrency carefully; BullMQ retries are an execution optimization, not a transactional store.
- Repeatable/polling schedulers for menu pull and the outbox sweeper, with startup scans and distributed singleton locking for scheduled tasks where appropriate.
- **Sample starting schedules (configurable, not hard guarantees):** menu pull every 30 seconds while online; outbox sweep every 5 seconds; checkpoint reconciliation hourly plus daily deep reconciliation.
- Health checks and structured JSON logs with `requestId`, `outletId`, `eventId`, `saleId`, `receiptNo`, `revision` (no sensitive data).
- Metrics: `outbox_pending_count`, `oldest_pending_age_seconds`, `sync_delivery_success_rate`, `sync_api_latency`, `menu_revision_lag`, `sync_quarantined_count`, `sale_transaction_latency`, `stock_conflicts_total`. Alert on stuck backlog, snapshot errors, missing sequences, and key revocation.
- OpenTelemetry traces across HTTP → service → DB → outbox/worker → HQ API.

## 11. Configuration and deployment

**Outlet backend environment variables (examples):** `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `OUTLET_JWT_ACCESS_SECRET`, `OUTLET_JWT_REFRESH_SECRET`, `OUTLET_JWT_ISSUER`, `OUTLET_JWT_AUDIENCE`, `MENU_PULL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_SWEEP_INTERVAL_MS`, `OFFLINE_GRACE_HOURS`. Outlet identity (`OUTLET_ID`, `OUTLET_CODE`) is an optional dev-seed input only; the HQ base URL and machine key are **not** environment variables — they arrive via the setup wizard and live in `hq_connection`.

Runtime-validated config schema (Zod/Joi) so missing critical values fail startup; secrets from a managed secret store; `.env.example` placeholders only; CORS allows only the outlet UI origin; secure HTTP headers, HTTPS termination, trusted proxy settings. Multi-stage `Dockerfile` with distinct `api` and `worker` commands/targets, non-root, health checks, pinned base-image digest in production; no secrets in build layers. Versioned TypeORM migrations — never share a migration folder or database with HQ. Database migration is a single controlled release job.

**Production topology:** deploy the outlet stack **once per outlet site** with its own DB volume, Redis, API, worker, and UI, plus protected outbound HTTPS to HQ. The dev sample has one outlet A but the system supports N independent sites. No container depends on HQ API reachability to complete an outlet sale.

**Backup/restore:** encrypt PostgreSQL backups, test restores, and define recovery objectives. Outlet restore must never reuse prior receipt numbers or resend event IDs with altered payloads; restore the outbox and receipt counter consistently from the **same local DB backup**.

## 12. Nonfunctional targets

| Measure | Target |
|---|---|
| Local sale API latency | p95 < 500 ms in normal site LAN for ≤10 items (benchmark hardware first). |
| Inventory and receipts | 0 oversells and 0 duplicate receipt numbers in concurrency tests. |
| Sync recovery | 99% of pending events delivered within 2 minutes **after connectivity is restored**, absent HQ incident/backpressure. |
| Menu freshness | HQ changes applied within 60 seconds under normal load with 30s polling. |
| Durable delivery | No committed sale without its outbox row. |
| Operational recovery | Document and test DB backup/restore and dead-letter replay. |

## 13. Acceptance scenarios (outlet-backend-relevant subset)

| ID | Scenario | Expected result |
|---|---|---|
| AT-01 | HQ assigns item only to A and B | A/B eventually receive item; C never receives or sells it. |
| AT-02 | Outlet B price override $12 vs default $10 | B prices new sales at $12; existing sale snapshots unchanged. |
| AT-03 | Sale 2 burgers + 1 pizza | Correct computed totals, stock movements, one receipt, one outbox event. |
| AT-04 | Any line lacks stock | 409; no sale, stock delta, receipt increment or event. |
| AT-05 | Two simultaneous purchases of the last unit | Exactly one success; stock remains ≥ 0. |
| AT-06 | 100 concurrent sales at same outlet | Distinct sequential committed receipts; no duplicates; row lock protects counter. |
| AT-07 | Repeat same POST with same idempotency key | Same sale/receipt returned; no second deduction/event. |
| AT-08 | Same idempotency key, altered body | 409; original sale unchanged. |
| AT-09 | Worker crashes after HQ commit before local ACK | Retry returns DUPLICATE; one HQ sale and projection. |
| AT-10 | Redis unavailable after sale commit | Sale still commits; periodic outbox scanner resumes once Redis returns. |
| AT-11 | Outlet offline 24 hours | Local permitted sales continue; ordered outbox backlog delivered after reconnect. |
| AT-12 | HQ unassigns item during outage | Old local menu may sell until sync; after REMOVE applied, new sale denied; exceptions audited. |
| AT-13 | Menu page application crashes | Transaction rolls back; cursor not advanced; safe retry. |
| AT-14 | Catalog history gap requires snapshot | Atomic staging/replacement catches up to revision without losing concurrent changes. |
| AT-15 | Event replay with same ID + different payload | Rejected and flagged; accepted event not overwritten. |
| AT-18 | Old refresh token reused after rotation | Token family revoked and audited. |
| AT-21 | Duplicate or out-of-order event sequences | No duplicate business effects at HQ; contiguous checkpoint advances only when gaps filled. |
| AT-22 | Local DB restore + replay | Receipt counter and outbox remain consistent; resends deduplicated by HQ. |

**Testing layers:** Jest/Vitest unit tests for services and guards; integration tests against **real PostgreSQL and Redis** via containers (SQLite is insufficient for row-lock behavior); API/contract tests for OpenAPI and event v1; **contract tests against the HQ sync endpoints** (typed machine client); concurrency stress with parallel clients; property-based money/quantity tests; network partition and crash injection. CI runs migrations on fresh databases.

## 14. Folder structure

```text
outlet-backend/                      # Independent Outlet NestJS application
│
├── src/
│   ├── main.ts                      # HTTP entry point
│   ├── worker-main.ts               # Outlet worker entry point
│   ├── app.module.ts
│   │
│   ├── config/
│   │   ├── app.config.ts
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
│   │   ├── hq-sync.config.ts
│   │   └── env.validation.ts
│   │
│   ├── common/
│   │   ├── auth/
│   │   ├── rbac/
│   │   ├── filters/
│   │   ├── interceptors/
│   │   ├── validation/
│   │   └── utils/
│   │
│   ├── database/
│   │   ├── migrations/
│   │   ├── entities/
│   │   ├── seeds/
│   │   └── data-source.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── menu-cache/
│   │   ├── inventory/
│   │   ├── sales/
│   │   ├── receipts/
│   │   ├── outbox/
│   │   ├── sync/
│   │   │   ├── services/
│   │   │   ├── repositories/
│   │   │   ├── processors/
│   │   │   └── clients/
│   │   └── local-reporting/
│   │
│   ├── contracts/
│   │   └── sync-event-v1.schema.json
│   │
│   └── openapi/
│
├── docker/
│   ├── postgres/
│   │   └── init/
│   └── redis/
│       └── redis.conf
│
├── scripts/
│   ├── migrate.sh
│   └── seed.sh
│
├── test/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── contract/
│
├── Dockerfile                       # Outlet API and worker image
├── .dockerignore
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
└── nest-cli.json
```

**Layered module rule:** controller handles HTTP DTOs and guards; service owns business rules and transaction orchestration; repository encapsulates TypeORM queries and locking. A worker calls application services, not controllers. Repositories cannot make HTTP calls. Cross-module contracts use explicit interfaces and dependency injection. Use the global `ValidationPipe` with whitelist + reject unknown fields + transformation; `class-validator`/DTOs on server. Do not trust frontend validation as a security control. The typed **machine client** for HQ sync endpoints resolves the outlet key server-side from the `hq_connection` table (setup wizard / rotation route; re-read before every call so rotation lands without a restart) — never from environment variables, never in frontend code.

## 15. Roadmap phases (outlet-backend scope)

- **Phase 0 – Foundation:** app shell, strict TS, lint/format, env validation, CI, separate Postgres/Redis, Dockerfile, compose, migration pipeline, OpenAPI export, logging.
- **Phase 2 – Outlet operations:** outlet JWT/RBAC, catalog cache, inventory balances/movements, atomic multi-item sale, receipt counter, idempotent sale API, transactional outbox.
- **Phase 3 – Synchronization:** typed HQ sync client, pull deltas/snapshot, BullMQ dispatcher/workers, retries, reconciliation, status and alerting, offline policy.
- **Phase 4 – Hardening:** security tests, load/concurrency/failure tests, backup and recovery rehearsal.

**Definition of done (this service):** relevant AT scenarios pass; API docs match; production migrations and Docker deployment work; no leaked secrets; observability dashboards and on-call runbook exist; committed sales are never lost between sale commit and HQ acknowledgment.
