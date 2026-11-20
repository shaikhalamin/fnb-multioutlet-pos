# PRD — HQ Backend (`hq-backend`)

**Parent PRD:** [`../fnb_multi_outlet_prd.md`](../fnb_multi_outlet_prd.md) (Multi-Outlet F&B Management Platform, V1.0)
**Scope:** V1.0 core responsibilities only — optional / V1.1 items (HQ stock snapshots, optional inventory push, optional report-refresh queue, optional heartbeat endpoint, optional report filters) are excluded.
**Technology:** TypeScript, Node.js, NestJS (Express adapter), TypeORM, PostgreSQL, Redis/BullMQ, Zod, OpenAPI/Swagger, Docker

---

## 1. Overview and boundaries

`hq-backend` is the independent HQ NestJS application (HTTP entry `main.ts`, worker entry `worker-main.ts`). HQ is the **menu authority**: master items, outlet assignment, availability, price overrides, outlet credentials (API keys), and cross-outlet reporting are canonical here.

**Boundary rules that govern this service:**

- HQ **never** connects to or writes into an outlet database. All synchronization is outlet-initiated: outlet workers pull menu changes and push events over HTTPS.
- HQ maintains **read projections** from accepted outlet events; replication lag must be disclosed (`dataAsOf`, sync watermarks).
- HQ API keys must never be exposed to browser frontends; sync endpoints have no browser/CORS access.
- Do not replicate user password hashes, refresh tokens, or outlet inventory balances into HQ master-menu tables.
- Exactly-once **business effects** are achieved via unique keys, transactional inbox processing, and immutable event IDs — never by assuming exactly-once transport.

**Core reliability contract handled here:** every accepted event's inbox record and business projection commit in **one HQ PostgreSQL transaction**; no ACK is returned before that commit.

## 2. Functional responsibilities

| FR | Responsibility (HQ side) |
|---|---|
| FR-01 | HQ menu catalog: create/update/archive/list categories and master menu items. Item has immutable UUID, SKU (unique within company), name, description, category, currency, default price, status. A master item change creates outlet-specific change-log events for all impacted assignments. Deleted/archived items use a status/tombstone, never silent hard-delete. |
| FR-02 | Outlet assignment and overrides: assign/unassign items to outlets; at most one effective assignment per `(outlet_id, menu_item_id)`; nullable override price; effective price = override or master default; nonnegative integer minor units, single consistent currency. HQ edits are atomic with per-outlet revision generation and change-log writes. |
| FR-03 (server side) | Serve revisioned catalog changes/snapshot to authenticated outlet keys — only for the outlet bound to the key. |
| FR-07 (ingest side) | Transactional inbox ingestion of outlet events with per-event acknowledgement; duplicates return successful duplicate ACKs; permanent failures are `REJECTED_PERMANENT`; projections are written in the same transaction. |
| FR-08 | Reports: revenue by outlet and top-five quantity sellers per outlet from accepted, completed sales in HQ projections; include `dataAsOf` and per-outlet sync watermark/last-ingested time. Reports never query outlet databases. |
| FR-09 | HQ human auth: own `auth/login`, `auth/refresh`, `auth/logout`; short-lived access JWT + rotating refresh token; refresh reuse revokes the session family and is auditable; authorization checked on every protected request. |
| FR-10 | Administration and observability: issue/rotate/revoke/audit outlet API keys; health checks; structured logs; per-outlet menu revision, last sales event, failure count and last successful sync derived from checkpoints and ingested events. |

**FR-02 acceptance:** burger default USD 10.00, outlet B override USD 12.00 → outlet A gets `"1000"`, B gets `"1200"`; unassigned outlet C sees no burger and cannot sell it.

## 3. HQ PostgreSQL schema

All IDs UUID unless specified. Audit columns: `created_at timestamptz NOT NULL`, `updated_at timestamptz NOT NULL`; nullable `deleted_at` where soft deletion applies.

| Table | Important fields | Constraints and purpose |
|---|---|---|
| `companies` | `id`, `name`, `currency_code` | V1 single company; future-ready scope. |
| `outlets` | `id`, `company_id`, `code`, `name`, `timezone`, `status`, `created_at` | FK company; UNIQUE(company_id, code); status ACTIVE/SUSPENDED. |
| `hq_users` | `id`, `company_id`, `email`, `password_hash`, `status` | UNIQUE(company_id, lower(email)); no plaintext secrets. |
| `hq_roles`, `hq_permissions`, `hq_user_roles`, `hq_role_permissions` | role/permission relationships | Unique composite mapping keys; permissions e.g. `menu.write`, `reports.read`. |
| `hq_refresh_sessions` | `id`, `user_id`, `family_id`, `token_hash`, `expires_at`, `revoked_at`, `rotated_at` | Indexed user/family; token rotation and reuse response. |
| `menu_categories` | `id`, `company_id`, `name`, `sort_order`, `status` | FK company; UNIQUE(company_id, name). |
| `master_menu_items` | `id`, `company_id`, `category_id`, `sku`, `name`, `description`, `default_price_minor bigint`, `currency_code`, `status`, `version int` | UNIQUE(company_id, sku); CHECK(price >= 0); FK category; mutable catalog, immutable ID. |
| `outlet_menu_assignments` | `id`, `outlet_id`, `menu_item_id`, `price_override_minor bigint NULL`, `active boolean`, `version int` | UNIQUE(outlet_id, menu_item_id); CHECK(override >= 0); FKs; never hard-delete history. |
| `outlet_catalog_revisions` | `outlet_id`, `current_revision bigint` | One locked row per outlet; increment inside menu-change transaction. |
| `outlet_catalog_changes` | `id`, `outlet_id`, `revision bigint`, `action`, `payload jsonb`, `recorded_at` | UNIQUE(outlet_id, revision); changes include tombstones. |
| `outlet_api_keys` | `id`/`key_id`, `outlet_id`, `secret_hash`, `scopes text[]`, `status`, `expires_at`, `last_used_at`, `rotated_from_id` | Never store the raw secret; allow multiple overlapping active keys for rotation. |
| `sync_inbox_events` | `id`, `outlet_id`, `event_id`, `sequence_no bigint`, `event_type`, `payload_sha256`, `schema_version`, `status`, `received_at` | UNIQUE(outlet_id,event_id) and UNIQUE(outlet_id,sequence_no); replay detection. |
| `hq_sales` | `id`, `outlet_id`, `source_sale_id`, `receipt_no`, `sold_at`, `total_minor bigint`, `currency_code`, `status`, `ingested_at` | UNIQUE(outlet_id,source_sale_id), UNIQUE(outlet_id,receipt_no); immutable accepted sales projection. |
| `hq_sale_items` | `id`, `hq_sale_id`, `source_sale_item_id`, `menu_item_id`, `name_snapshot`, `quantity`, `unit_price_minor bigint`, `subtotal_minor bigint` | FK sale; UNIQUE(hq_sale_id,source_sale_item_id); preserve historical prices. |
| `sync_outlet_checkpoints` | `outlet_id`, `highest_contiguous_sequence`, `last_event_at`, `last_menu_seen_revision` | Detect gaps and stale outlets. |
| `audit_logs` | `id`, `actor_type`, `actor_id`, `action`, `entity_id`, `metadata jsonb`, `occurred_at` | Immutable operations/security audit. |

**HQ-side SQL protections:**

```sql
CREATE UNIQUE INDEX uq_hq_sale_source ON hq_sales(outlet_id, source_sale_id);
CREATE UNIQUE INDEX uq_hq_receipt ON hq_sales(outlet_id, receipt_no);
CREATE UNIQUE INDEX uq_hq_inbox_event ON sync_inbox_events(outlet_id, event_id);
CREATE UNIQUE INDEX uq_hq_inbox_sequence ON sync_inbox_events(outlet_id, sequence_no);
CREATE INDEX idx_hq_sales_reporting ON hq_sales(outlet_id, sold_at)
  WHERE status = 'COMPLETED';
CREATE INDEX idx_hq_sale_items_item ON hq_sale_items(menu_item_id, hq_sale_id);
CREATE INDEX idx_catalog_changes_cursor ON outlet_catalog_changes(outlet_id, revision);
```

Additional indexes: `master_menu_items(company_id,status,category_id)`, `outlet_menu_assignments(outlet_id,active)`, `sync_inbox_events(outlet_id,received_at DESC)`, case-insensitive user email uniqueness. Use real migrations, never `synchronize: true`, in all environments.

**Entity rules:** no cross-database FK to outlets is possible — carry UUID references and validate according to authority. `hq_sale_items.hq_sale_id` FKs to `hq_sales`. Amounts stored as `bigint`, manipulated as `bigint` in TypeScript, serialized as canonical decimal strings; reject unsafe/out-of-range values in DTOs.

## 4. HTTP API surface

Base URL: `https://hq.example.com/api/v1`. Swagger at `/api/docs` in development/admin-restricted environments; machine-readable `/openapi.json` artifact in CI. `Content-Type: application/json`; UTC ISO 8601 timestamps; UUID IDs; integer quantities; money strings match `^[0-9]+$` bounded to `bigint`. Human endpoints use `Authorization: Bearer <access_jwt>`; machine sync endpoints use `Authorization: OutletKey <keyId>.<secret>` with key scopes. Every write accepts/returns `X-Request-Id`. Stable error codes; correct 401/403/404/409/422/429/503; hide resources across unauthorized outlet scopes (never leak content).

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

**Schema naming:** `CreateSaleRequest`, `SaleResponse`, `AssignMenuRequest`, `OutletMenuResponse`, `CatalogChangesResponse`, `EventBatchRequest`, `EventBatchResponse`. Key-issuance endpoints are internal/admin; secrets never appear in generated frontend logs.

### 4.1 HQ endpoints (human JWT)

| Method | Route | Permissions | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | Public with rate limit | HQ sign in. |
| `POST` | `/auth/refresh` | Refresh cookie/session | Rotate refresh token. |
| `POST` | `/auth/logout` | Authenticated | Revoke session. |
| `GET/POST` | `/menu-items` | `menu.read` / `menu.write` | List/create master items. |
| `GET/PATCH` | `/menu-items/:id` | `menu.read` / `menu.write` | Read/update item. |
| `GET/POST` | `/outlets` | `outlets.read` / `outlets.write` | List/provision outlets. |
| `PUT` | `/outlets/:outletId/menu/:itemId` | `assignments.write` | Assign/activate and optionally override price. |
| `DELETE` | `/outlets/:outletId/menu/:itemId` | `assignments.write` | Soft-unassign + create removal revision. |
| `POST` | `/outlets/:outletId/api-keys` | `keys.manage` | Issue key; reveal secret once. |
| `POST` | `/outlets/:outletId/api-keys/:keyId/rotate` | `keys.manage` | Rotate with bounded overlap. |
| `DELETE` | `/outlets/:outletId/api-keys/:keyId` | `keys.manage` | Revoke key. |
| `GET` | `/reports/revenue-by-outlet?from=&to=` | `reports.read` | Completed revenue per outlet. |
| `GET` | `/reports/outlets/:id/top-items?from=&to=&limit=5` | `reports.read` | Top item quantities (max 5 in V1). |
| `GET` | `/outlets/:id/sync-status` | `sync.read` | Outbox replication status known to HQ. |

**Assign menu request / response:**

```http
PUT /api/v1/outlets/61de28db-92ed-46ef-9d90-3a951ac03420/menu/9708835e-2e21-465a-87e9-5f8d56cd44ab
Authorization: Bearer <hq-jwt>
Content-Type: application/json

{ "active": true, "priceOverrideMinor": "1200" }
```

```json
{
  "data": {
    "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420",
    "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab",
    "active": true,
    "defaultPriceMinor": "1000",
    "priceOverrideMinor": "1200",
    "effectivePriceMinor": "1200",
    "currencyCode": "USD",
    "catalogRevision": "42"
  }
}
```

### 4.2 HQ sync APIs (outlet key, no browser access)

| Method | Route | Key scope | Behavior |
|---|---|---|---|
| `GET` | `/sync/v1/menu/changes?afterRevision=42&limit=500` | `menu.pull` | Fetch only changes for authenticated outlet, ascending revision. |
| `GET` | `/sync/v1/menu/snapshot` | `menu.pull` | Consistent full catalog snapshot for bootstrap/gap recovery. |
| `POST` | `/sync/v1/events/batch` | `events.push` | Idempotent inbox ingestion with per-event acknowledgements. |
| `GET` | `/sync/v1/checkpoint` | `events.push` | Highest contiguous accepted outlet event sequence + missing ranges (reconciliation). |

HQ derives `outletId` **exclusively** from the key record; any `outletId` in a submitted event must match or the entire request is denied. Keys cannot use HQ administrative routes. Use TLS, IP allow-list where possible, rate limits, payload size limits, short request timeouts, and key rotation.

## 5. Menu change generation (distribution engine)

1. HQ commits an item edit/assignment edit in a DB transaction.
2. For **each affected outlet**, lock its `outlet_catalog_revisions` row, increment revision, and append one canonical change entry describing the final outlet-specific effective item state (`UPSERT` or `REMOVE`); a change affecting 100 outlets records per-outlet changes.
3. Return a successful admin response only after the menu mutation and all corresponding changes are committed atomically.
4. A change entry must be reproducible and schema-versioned. `UPSERT` includes all POS-needed fields, price override result, active status and item version; do not rely on fetching current master item state later to reconstruct an old delta.
5. For high fan-out, use a transactional HQ change outbox + ordered fan-out processing and mark assignment distribution `PENDING` until all revisions are published; **do not** commit the admin change without a durable record of work to distribute it.

**Menu changes response served to outlets:**

```json
{
  "data": {
    "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420",
    "fromRevision": "41",
    "nextRevision": "42",
    "headRevision": "42",
    "hasMore": false,
    "snapshotRequired": false,
    "changes": [
      {
        "revision": "42",
        "type": "UPSERT",
        "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab",
        "item": {
          "assignmentId": "31fe8f6b-02b8-409d-b1fa-6c441f422949",
          "sku": "BURGER-01",
          "name": "Chicken Burger",
          "description": "Grilled chicken burger",
          "category": "Burgers",
          "unitPriceMinor": "1200",
          "currencyCode": "USD",
          "active": true,
          "itemVersion": 3
        }
      }
    ]
  }
}
```

**Snapshot correctness (server side):** snapshot response includes `snapshotId`, `snapshotRevision`, pages/cursor, and a stable view for the snapshot lifetime so concurrent updates are not lost for outlets that resume changes after that exact revision.

## 6. Sync ingest contract

### 6.1 Event batch ingestion (per-event ACK)

```http
POST /api/v1/sync/v1/events/batch
Authorization: OutletKey ok_live_123.<redacted-secret>
Idempotency-Key: 047bfdb5-727a-47eb-970a-03a038c11b92
Content-Type: application/json

{ "batchId": "047bfdb5-727a-47eb-970a-03a038c11b92", "events": [ /* sale.completed events */ ] }
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

Event outcomes: `ACCEPTED`, `DUPLICATE`, `RETRYABLE_ERROR`, `REJECTED_PERMANENT`. A `DUPLICATE` has the **same canonical payload hash** as the accepted event and is terminal success. Reusing `(outletId,eventId)` or `(outletId,sequenceNo)` with a *different* payload is `REJECTED_PERMANENT` plus security/audit alert; never overwrite the original. `RETRYABLE_ERROR` is not acknowledged. HTTP 200 may include mixed event statuses; HTTP 401/403/413/429/5xx applies to the batch/request.

**Batch idempotency:** HQ may store a batch key + request hash to reject a changed payload with the same batch ID. Enforce batch limits (e.g. 100 events / 1 MiB).

### 6.2 Ingested `sale.completed` event shape (schema v1, produced by outlets)

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

**Integrity invariants enforced at ingest:** `sum(item.subtotalMinor) = totalMinor`; `quantity * unitPriceMinor = subtotalMinor`; event's outlet ID equals authenticated key outlet; sale is immutable and exactly one logical receipt belongs to `(outletId, receiptNo)`. Unknown required schema versions are quarantined rather than silently ignored.

### 6.3 HQ inbox transaction (per event)

Authenticate outlet key → validate schema/version and outlet match → validate totals/identifiers → insert inbox event with unique event ID and immutable hash → insert sale header/lines projection (for `sale.completed`) → update contiguous sequence tracking if possible → commit → return ACK. If duplicate ID and same hash, return `DUPLICATE` from the committed record. If the transaction fails before commit, send a retryable error. All event business effects and inbox deduplication must be in **one HQ PostgreSQL transaction**. Do not assume BullMQ job-ID deduplication replaces the database inbox.

### 6.4 Reconciliation and retention (HQ side)

- **Ordering:** events may arrive out of order; track highest **contiguous** accepted sequence, not `MAX(sequenceNo)`. Do not block independent sale ingestion solely because an earlier event is delayed; account for gaps in reconciliation. Serve the checkpoint (`highestContiguousSequence` + missing ranges) so workers can selectively replay.
- **Daily reconciliation:** compare outlet-reported completed sale count, totals and receipt ranges to HQ projections for an agreed UTC/date window; alert on mismatch; never auto-insert fabricated sales.
- **Retention:** keep sales/receipt records per legal policy; keep inbox dedupe records for at least the full replay/archive horizon (recommended effectively permanent compact identity/hash).
- Offline-period sales: HQ accepts historically valid completed sales as immutable source events, subject to anti-fraud/identity checks, and flags catalog revision/price disagreements for audit — never changes receipt prices or silently deletes sales.

## 7. Authentication, API keys, RBAC

### 7.1 Human JWT sessions (HQ)

- `HQ_JWT_ISSUER`/`HQ_JWT_AUDIENCE`; own signing keys/key IDs; access token lifetime target **10–15 minutes**. Claims: `sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `scope`/role IDs. Recheck user active status and high-impact permissions against server state or short-lived cache to enforce revocations promptly.
- Refresh token: high-entropy opaque random token, rotated on each refresh, store **only hash** in DB; browser holds it in `HttpOnly`, `Secure`, suitable `SameSite` cookie with CSRF protections. `POST /auth/refresh` must serialize rotation or use compare-and-swap on the token hash; a stolen/reused old token invalidates its refresh family; audit sign-in, refresh reuse and permission changes. MFA for HQ admins is strongly recommended.
- Passwords: Argon2id/bcrypt with strong parameters; login rate limits/lockout.
- Guards validate signed JWT **and** `iss`, `aud`, `exp`, `sub`, enabled account status, and permission on every protected route.

**Login response shape:**

```json
{
  "data": {
    "accessToken": "<signed-jwt>",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "user": {
      "id": "f5df2a66-119c-45e5-b797-fd31cfd93aa8",
      "roleCodes": ["HQ_MENU_MANAGER"],
      "permissions": ["menu.read", "menu.write", "assignments.write"]
    }
  }
}
```

(Refresh token is set in an HTTP-only cookie, not returned in JSON.)

### 7.2 Machine outlet API keys (HQ registry)

- Generate a 256-bit cryptographically random secret with non-secret `keyId`; show the raw key **once** to an authorized HQ admin/secure provisioning channel.
- Store indexed `keyId` plus a server-side keyed digest or strong secret hash (`OUTLET_KEY_PEPPER` in a secret manager), never plaintext; compare in constant time.
- Each key maps to exactly one `outlet_id` with narrow `menu.pull` and `events.push` scopes.
- Rotation: create a replacement key with time-limited dual validity; after the worker switches and `last_used_at` confirms, revoke the old key. Revocation blocks new sync calls but cannot retroactively change accepted sales.
- Require TLS (mTLS recommended for higher assurance); rate-limit and cap body sizes per key; no CORS browser access to sync endpoints; reject `outletId` mismatch.

### 7.3 HQ permission matrix

| Action | HQ Super Admin | HQ Menu Manager | HQ Analyst |
|---|---|---|---|
| Edit master menu | Yes | Yes | No |
| Assign/price menu | Yes | Yes | No |
| Manage outlet API keys | Yes | No | No |
| Read cross-outlet reports | Yes | No | Yes |
| Read sync status | Yes | Yes | Yes |

No frontend route hiding is sufficient authorization; always enforce backend guards and ownership checks.

## 8. Reporting definitions

**Revenue by outlet** counts locally `COMPLETED` sales successfully accepted into HQ `hq_sales`, summed from immutable `total_minor`. Filter `from` inclusive, `to` exclusive, UTC. V1 uses one company currency — never sum unlike currencies. A missing outlet contribution may mean unsynced sales, not zero; disclose it.

```http
GET /api/v1/reports/revenue-by-outlet?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z
```

```json
{
  "data": {
    "currencyCode": "USD",
    "outlets": [
      { "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420", "outletName": "Outlet B", "totalRevenueMinor": "750000", "completedSaleCount": 450, "lastIngestedAt": "2026-11-20T04:02:10Z" }
    ],
    "totalRevenueMinor": "750000",
    "dataAsOf": "2026-11-20T04:02:10Z",
    "isProvisional": true
  }
}
```

**Top items per outlet** groups `hq_sale_items` by stable `menu_item_id`, sums quantity, orders `quantitySold DESC`, then menu ID as deterministic tie-break; max 5 in V1.

```json
{
  "data": {
    "outletId": "61de28db-92ed-46ef-9d90-3a951ac03420",
    "items": [
      { "rank": 1, "menuItemId": "9708835e-2e21-465a-87e9-5f8d56cd44ab", "itemName": "Chicken Burger", "quantitySold": 250 },
      { "rank": 2, "menuItemId": "c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4", "itemName": "Pizza", "quantitySold": 200 }
    ],
    "dataAsOf": "2026-11-20T04:02:10Z"
  }
}
```

## 9. Validation and error handling

| Layer | HQ rules |
|---|---|
| Controller | Nest DTO validation via global `ValidationPipe` (whitelist, forbid unknown properties, transformation); sanitize strings; max payload size; UUID/ISO/date validation. |
| Service | Business rules: assignment validity, price resolution, currency, outlet isolation, revision generation. |
| Repository/DB | FK, UNIQUE, CHECK, transactions, row locks, index-backed queries. |
| Worker | Validate envelopes, versions, checksum; fan-out processing. |
| HQ ingest | Verify key/outlet, schema and totals; transactional inbox, immutable projection, reject conflicts. |

**Standard error codes used:** `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `EVENT_ID_CONFLICT`, `UNSUPPORTED_EVENT_VERSION`, `RATE_LIMITED`, plus stable 401/403/404/409/422/429/503 semantics.

## 10. Queues and operational design

- Separate HQ Redis namespace/instance. HQ queues: `catalog-fanout` (for asynchronous high fan-out distribution) and `audit-cleanup`. Jobs include IDs and look up DB records; queue payloads contain **no** bearer credentials or full PII-heavy sale details. BullMQ is an execution optimization, not a transactional store.
- Health checks and structured JSON logs with `requestId`, `outletId`, `eventId`, `revision` (no sensitive data).
- Metrics: `inbox_duplicates_total`, `sync_quarantined_count`, `hq_reporting_lag_seconds`, `menu_revision_lag`, `sync_api_latency`. Alert on key revocation, stuck backlog, snapshot errors, missing sequences, and reporting discrepancies.
- OpenTelemetry traces across HTTP → service → DB → worker.

## 11. Configuration and deployment

**HQ backend environment variables (examples):** `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `HQ_JWT_PRIVATE_KEY`, `HQ_JWT_PUBLIC_KEY`, `HQ_JWT_ISSUER`, `HQ_JWT_AUDIENCE`, `OUTLET_KEY_PEPPER`, `CORS_ORIGINS`, `LOG_LEVEL`, `SYNC_MAX_BODY_BYTES`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`.

Runtime-validated config schema (Zod/Joi) so missing critical values fail startup; secrets from a managed secret store; `.env.example` placeholders only; CORS allows only the HQ UI origin; secure HTTP headers, HTTPS termination, trusted proxy settings. Multi-stage `Dockerfile` with distinct `api` and `worker` commands/targets, non-root, health checks, pinned base-image digest in production; no secrets in build layers. Database migration is a **single controlled release job**, never concurrently on every API replica. Versioned TypeORM migrations — never share a migration folder or database with outlets. Encrypt PostgreSQL backups and test restores.

**Local compose services (HQ side):** `hq-db`, `hq-redis`, `hq-api` (API entrypoint), `hq-worker` (worker entrypoint), `hq-web`. HQ is deployed centrally; network policy must ensure HQ has no inbound route to any outlet DB.

## 12. Nonfunctional targets

| Measure | Target |
|---|---|
| Menu freshness | Changes visible at connected outlets within 60 seconds under normal load with 30s polling. |
| Durable delivery | No ACK without HQ inbox/projection commit. |
| HQ report clarity | Explicit data freshness; never a misleading real-time guarantee. |
| Operational recovery | Documented and tested DB backup/restore, key rotation, and dead-letter/replay handling. |

## 13. Acceptance scenarios (HQ-backend-relevant subset)

| ID | Scenario | Expected result |
|---|---|---|
| AT-01 | HQ assigns item only to A and B | A/B eventually receive item; C never receives or sells it. |
| AT-02 | Outlet B price override $12 vs default $10 | B prices new sales at $12; existing sale snapshots unchanged. |
| AT-09 | Worker crashes after HQ commit before local ACK | Retry returns DUPLICATE; one HQ sale and projection. |
| AT-12 | HQ unassigns item during outage | After REMOVE applied at outlet, new sale denied; exceptions audited. |
| AT-15 | Event replay with same ID + different payload | Rejected and flagged; accepted event not overwritten. |
| AT-16 | API key for outlet A requests B data | Denied; no B rows leaked. |
| AT-17 | Cashier tries HQ menu admin route | JWT/issuer/permission denied. |
| AT-18 | Old refresh token reused after rotation | Token family revoked and audited. |
| AT-19 | HQ changes price after synced sale | Past receipt and revenue preserve prior unit price. |
| AT-20 | HQ reporting during outlet backlog | Reports disclose stale ingestion timestamp/watermark. |
| AT-21 | Duplicate or out-of-order event sequences | No duplicate business effects; contiguous checkpoint advances only when gaps filled. |
| AT-22 | Outlet DB restore + replay | HQ deduplicates resent events; revenue not double-counted. |

**Testing layers:** Jest/Vitest unit tests for services and guards; integration tests against **real PostgreSQL and Redis** via containers; API/contract tests for OpenAPI and event v1; CI runs migrations on fresh databases and exports the `/openapi.json` artifact for the HQ frontend Kubb pipeline.

## 14. Folder structure

```text
hq-backend/                          # Independent HQ NestJS application
│
├── src/
│   ├── main.ts                      # HTTP entry point
│   ├── worker-main.ts               # HQ worker entry point
│   ├── app.module.ts
│   │
│   ├── config/
│   │   ├── app.config.ts
│   │   ├── database.config.ts
│   │   ├── redis.config.ts
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
│   │   ├── outlets/
│   │   ├── menu/
│   │   ├── assignments/
│   │   ├── api-keys/
│   │   ├── sync-ingest/
│   │   ├── reporting/
│   │   └── audit/
│   │
│   ├── queues/
│   │   ├── processors/
│   │   └── producers/
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
│   └── e2e/
│
├── Dockerfile                       # HQ API and worker image
├── .dockerignore
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
└── nest-cli.json
```

**Layered module rule:** controller handles HTTP DTOs and guards; service owns business rules and transaction orchestration; repository encapsulates TypeORM queries and locking. A worker calls application services, not controllers. Repositories cannot make HTTP calls. Cross-module contracts use explicit interfaces and dependency injection. Do not trust frontend validation as a security control.

## 15. Roadmap phases (HQ-backend scope)

- **Phase 0 – Foundation:** app shell, strict TS, lint/format, env validation, CI, separate Postgres/Redis, Dockerfile, compose, migration pipeline, OpenAPI export, logging.
- **Phase 1 – Security / HQ catalog:** HQ JWT + rotating refresh, HQ users/RBAC, outlets, master menu CRUD, assignments and prices, outlet key issuance/rotation, per-outlet catalog revisions and changes.
- **Phase 3 – Synchronization (HQ side):** transactional inbox ingestion, per-event ACKs, retries semantics, reconciliation, status and alerting.
- **Phase 4 – Reporting / hardening:** revenue/top items, staleness indicators, audit, cross-outlet security tests, load/failure tests, backup and recovery rehearsal.

**Definition of done (this service):** relevant AT scenarios pass; API docs and exported OpenAPI match the HQ frontend generated clients; production migrations and Docker deployment work; no leaked secrets; observability dashboards and on-call runbook exist; a failed/duplicate sync cannot double-count HQ revenue.
