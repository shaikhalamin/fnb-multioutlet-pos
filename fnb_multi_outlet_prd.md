# Product Requirements Document (PRD)

## Multi-Outlet F&B Management Platform

**Architecture:** Independent HQ and outlet applications with secure outlet-initiated synchronization  
**Status:** Proposed implementation baseline  
**Version:** 1.0  
**Date:** 20 November 2026  
**Technology:** TypeScript, Node.js, NestJS (Express adapter), TypeORM, PostgreSQL, Redis/BullMQ, React, TanStack Router/Query, Zod, Kubb, Axios, OpenAPI/Swagger, Docker

---

## 1. Executive summary

Build a multi-outlet F&B platform in which Headquarters (HQ) manages the master menu, outlet assignment, outlet-specific selling prices, outlet credentials, and cross-outlet reporting. Every outlet runs a distinct backend, frontend, PostgreSQL database, and background synchronization worker. An outlet can complete valid sales using its last successfully synchronized catalog and local inventory even during a temporary HQ/network outage, subject to an explicit offline sales policy.

There are four primary applications: **`hq-backend`**, **`outlet-backend`**, **`hq-frontend`**, and **`outlet-frontend`**. They will live under folder fnb-platform but must have independent deployments, security boundaries, data persistence, and release lifecycles. Outlet workers initiate *all* HQ synchronization calls. HQ does not connect to or write into an outlet database.

**Core reliability contract:** local sale + inventory movement + receipt allocation + outbox record commit atomically in the outlet PostgreSQL database; retries of the outbound delivery are expected; HQ achieves exactly-once **business effects** using unique keys, transactional inbox processing, and immutable event IDs, not by assuming exactly-once transport.

### 1.1 Business goals

1. Centralize menu governance while permitting different outlet menus and prices.
2. Let outlets process multi-item sales accurately and independently.
3. Prevent negative stock, overselling, and receipt duplication under concurrency.
4. Preserve historical selling prices even after HQ price changes.
5. Provide HQ consolidated revenue and top-selling-item reporting with visibility into sync freshness.
6. Keep user access, synchronization credentials, and tenant/outlet data rigorously isolated.
7. Recover automatically from duplicate requests, worker crashes, lost acknowledgements, and intermittent connectivity.

### 1.2 Not in the initial release

Ingredient-level recipes/BOM, purchasing and supplier workflows, loyalty, payment gateway integration, multi-currency conversion, tax jurisdiction automation, returns/refunds/exchanges, inventory transfers, promotion engines, and complex HQ inventory control. These may be added as versioned extensions. V1 stores inventory in sellable *menu-item units*, not ingredient quantities.

### 1.3 Key architectural assumptions and decisions

| Topic | Decision |
|---|---|
| Company topology | One company with many outlets; model `company_id` for future tenant isolation. |
| Deployment | Central HQ deployment; one logical outlet PostgreSQL database per outlet. Multiple outlet API/worker replicas may share that outlet database. |
| Sync direction | **Outbound-only from outlet to HQ**: outlet pulls menu changes and pushes events. |
| Menu authority | HQ master items, assignments, availability, and price overrides are canonical. |
| Operational authority | Outlet sales, inventory balances, movements, receipt allocation, and unsent outbox are canonical at the outlet. |
| Reporting authority | HQ maintains read projections from accepted outlet events; replication lag is disclosed. |
| Money | ISO currency + integer **minor-unit** amounts, represented as decimal strings in HTTP JSON to avoid JavaScript `BIGINT` precision loss. |
| Time | ISO 8601 UTC instants (`...Z`), stored as PostgreSQL `timestamptz`; outlet local zone stored separately for business-day reporting. |
| IDs | UUID for entities and events; protected, per-outlet integer receipt counter for display receipts. |
| Transport | TLS HTTPS REST + versioned JSON; short polling and durable retries. No direct cross-database access. |
| Framework | NestJS with Express HTTP adapter, not a second independent Express application. |

---

## 2. Context and system boundaries

```text
                            HQ ENVIRONMENT
 +-----------------+          +------------------------+
 |   HQ React UI   | --JWT--> | HQ NestJS API          |
 +-----------------+          | auth / RBAC / menu     |
                              | assignment / keys      |
                              | sync ingest / reports  |
                              +-----+-------------+----+
                                    |             |
                               PostgreSQL    Redis / BullMQ
                                    |
                      HTTPS / Outlet API key / TLS
                                    ^
                Outlet workers PUSH events and PULL menu
                                    |
 +------------------------------------------------------------------+
 | OUTLET A ENVIRONMENT (independently deployable)                   |
 | React POS UI --JWT--> NestJS Outlet API -- PostgreSQL A          |
 |                            |       |                             |
 |                         BullMQ <- Outbox dispatcher              |
 |                            |                                     |
 |                      Outlet sync worker                          |
 +------------------------------------------------------------------+

 +------------------------------------------------------------------+
 | OUTLET B ENVIRONMENT (separate local DB, queues, API and worker)  |
 +------------------------------------------------------------------+
```

**Separation rules:** HQ API may never assume an outlet's PostgreSQL is reachable. Outlet business transactions must never depend on an HQ request. HQ API keys must not be exposed to browser frontends. Do not replicate user password hashes, refresh tokens, or outlet inventory balances into the HQ master-menu tables. Shared source packages may define contracts and utilities but must never contain cross-service TypeORM entities or repositories.

## 3. Stakeholders and personas

| Role | System | Primary permissions |
|---|---|---|
| HQ Super Admin | HQ | Manage outlets, users, roles, API keys, all menus, assignments, reports. |
| HQ Menu Manager | HQ | Manage categories/items, outlet assignment and price overrides. |
| HQ Analyst | HQ | Read cross-outlet reports and sync status; cannot modify operations. |
| Outlet Manager | Outlet | View assigned menu, make sales, adjust stock, manage authorized local users, view local reports. |
| Cashier | Outlet | Read active menu, create sales, view/reprint local receipts. |
| Inventory Clerk | Outlet | View stock and create audited stock adjustments; no menu master edits. |
| Outlet Sync Worker | Machine | Use *only* that outlet's HQ key to pull its catalog and push its events. |

**RBAC implementation:** both backends have their own user, role/permission assignment, token issuer and refresh-token tables. Route guards validate signed JWT **and** `iss`, `aud`, `exp`, `sub`, enabled account status, outlet scope, and permission. The outlet ID of a cashier is taken from server-side identity configuration/claims, not trusted from request JSON.

## 4. Functional requirements and acceptance criteria

### FR-01 HQ menu catalog

HQ can create, update, archive, and list categories and master menu items. A menu item has immutable UUID, SKU (unique within company), name, description, category, currency, default price, and status. A master item change creates outlet-specific change-log events for all impacted assignments. A deleted/archived item is represented by a status/tombstone, not silently hard-deleted from history.

### FR-02 Outlet assignment and overrides

HQ can assign/unassign an item to one or more outlets. At most one effective assignment for a given `(outlet_id, menu_item_id)` exists. Override price is nullable; effective price = override or master default. Prices are nonnegative integer minor units and have a single currency consistent with the item/outlet. HQ edits are atomic with per-outlet revision generation and change-log writes.

**Acceptance:** If burger default is USD 10.00 and outlet B has USD 12.00 override, outlet A gets `"1000"`, B gets `"1200"`; unassigned outlet C sees no burger and cannot sell it.

### FR-03 Catalog distribution

An authenticated worker can only pull changes for the outlet bound to its key. The outlet persists a revisioned, read-optimized catalog locally. Apply a complete returned change batch and update the local checkpoint in one outlet DB transaction. `REMOVE`/deactivation prevents all *new* local sales after it is applied. An empty change response cannot delete local catalog data.

### FR-04 Outlet inventory

Outlet maintains one stock balance per assigned menu item and an append-only stock movement ledger. Restocks/adjustments record reason, actor and request ID. Selling quantity `q` requires `q > 0` and sufficient local stock. Inventory changes in one outlet must not affect another outlet. Atomic database updates enforce nonnegative balances.

### FR-05 Sales and receipts

A single sale can contain multiple distinct items and positive quantities. Backend resolves current local effective prices, computes line subtotal and total, and captures immutable price, item name/SKU snapshot, catalog revision and currency. Backend generates outlet-scoped receipts (`A-000001`, `A-000002`, etc.). No user-provided receipt number or total is accepted. Client-supplied **sale idempotency key** permits safe retries after timeouts.

### FR-06 Transaction integrity and concurrency

Complete each sale in one local PostgreSQL transaction: resolve and lock inventory rows in deterministic item-ID order; validate menu assignment/active status; decrement inventory; append stock movements; lock/update receipt counter; persist sale + lines; persist outbox event; persist HTTP idempotency result; commit. On any error, roll back everything. Do not enqueue BullMQ as a necessary part of this transaction.

**Acceptance:** Two concurrent purchases of the last burger produce exactly one committed sale; a multi-item sale with any insufficient item creates zero movements, zero receipt increments and zero outbox messages. Successful duplicate POST requests return the same sale and receipt without deducting stock again.

### FR-07 Durable synchronization

The outlet outbox dispatcher publishes eligible event IDs to BullMQ; sync workers read the corresponding durable database records, sign/authenticate HTTPS requests, and retry safely. HQ records events in its inbox within the same transaction as their business projections. Duplicate events return successful duplicate acknowledgements. Transient failures never discard an event. Permanent failures enter a quarantined state for operator review and correction.

### FR-08 Reports

HQ provides revenue by outlet and top-five quantity sellers for each outlet based on **accepted, completed** sales in its projections. Response includes `dataAsOf` and per-outlet sync watermark/last-ingested time; users must not confuse unsynced outlet sales with zero sales. Reports do not directly query outlet databases.

### FR-09 Authentication and permissions

Human-facing HQ and outlet API sessions use short-lived access JWT + rotating refresh token. Each backend has its own `auth/login`, `auth/refresh`, and `auth/logout` endpoints. Refresh token reuse revokes its session family and is auditable. Authorization is checked on every protected API request. Machine sync uses scoped outlet API keys rather than a human JWT.

### FR-10 Administration and observability

HQ admins can issue, rotate, revoke, and audit outlet keys. Both sides expose health checks and structured logs. HQ shows per-outlet menu revision, last sales event, failure count and backlog/last successful sync when reported by the worker.

### FR-11 Outlet self-provisioning

A new outlet terminal provisions itself through its setup wizard (no operator access to any environment or database required): step 1 saves the HQ-issued outlet ID + code and creates the first admin account in one local transaction (`POST /setup/identity`); step 2 pastes the one-time HQ machine key, which the outlet validates live against HQ before saving the pairing (`POST /setup/hq-connection`) — a key minted for a different outlet is refused. Both endpoints are public only while unprovisioned and seal permanently; subsequent key changes go through the audited `PUT /sync/hq-connection` (FR-10 switch-worker-secret step), and the sync worker reads credentials from the stored pairing so pairing and rotation take effect without a restart.

---

## 5. Project folder structure

Use this below folder structure. Keep exactly four independently built applications; workers live inside their respective backend projects and have separate runtime entrypoints.

```text
fnb-platform/
│
├── docker-compose.yml                   # Central Docker orchestration
├── .env                                 # Central Compose environment variables
├── .env.example
├── .gitignore
└── README.md
│
├── hq-backend/                          # Independent HQ NestJS application
│   │
│   ├── src/
│   │   ├── main.ts                      # HTTP entry point
│   │   ├── worker-main.ts               # HQ worker entry point
│   │   ├── app.module.ts
│   │   │
│   │   ├── config/
│   │   │   ├── app.config.ts
│   │   │   ├── configuration.module.ts
│   │   │   ├── database.config.ts
│   │   │   ├── redis.config.ts
│   │   │   └── env.schema.ts
│   │   │
│   │   ├── common/
│   │   │   ├── auth/
│   │   │   ├── rbac/
│   │   │   ├── filters/
│   │   │   ├── interceptors/
│   │   │   ├── validation/
│   │   │   └── utils/
│   │   │
│   │   ├── database/
│   │   │   ├── migrations/
│   │   │   ├── entities/
│   │   │   ├── seeds/
│   │   │   └── data-source.ts
│   │   │
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── users/
│   │   │   ├── outlets/
│   │   │   ├── menu/
│   │   │   ├── assignments/
│   │   │   ├── api-keys/
│   │   │   ├── sync-ingest/
│   │   │   ├── reporting/
│   │   │   └── audit/
│   │   │
│   │   ├── queues/
│   │   │   ├── processors/
│   │   │   └── producers/
│   │   │
│   │   ├── contracts/
│   │   │   └── sync-event-v1.schema.json
│   │   │
│   │   └── openapi/
│   │
│   ├── docker/
│   │   ├── postgres/
│   │   │   └── init/
│   │   └── redis/
│   │       └── redis.conf
│   │
│   ├── scripts/
│   │   ├── migrate.sh
│   │   └── seed.sh
│   │
│   ├── test/
│   │   ├── unit/
│   │   ├── integration/
│   │   └── e2e/
│   │
│   ├── Dockerfile                       # HQ API and worker image
│   ├── .dockerignore
│   ├── .env.example
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   └── nest-cli.json
│
├── outlet-backend/                      # Independent Outlet NestJS application
│   │
│   ├── src/
│   │   ├── main.ts                      # HTTP entry point
│   │   ├── worker-main.ts               # Outlet worker entry point
│   │   ├── app.module.ts
│   │   │
│   │   ├── config/
│   │   │   ├── app.config.ts
│   │   │   ├── configuration.module.ts
│   │   │   ├── database.config.ts
│   │   │   ├── redis.config.ts
│   │   │   ├── hq-sync.config.ts
│   │   │   └── env.schema.ts
│   │   │
│   │   ├── common/
│   │   │   ├── auth/
│   │   │   ├── rbac/
│   │   │   ├── filters/
│   │   │   ├── interceptors/
│   │   │   ├── validation/
│   │   │   └── utils/
│   │   │
│   │   ├── database/
│   │   │   ├── migrations/
│   │   │   ├── entities/
│   │   │   ├── seeds/
│   │   │   └── data-source.ts
│   │   │
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── users/
│   │   │   ├── menu-cache/
│   │   │   ├── inventory/
│   │   │   ├── sales/
│   │   │   ├── receipts/
│   │   │   ├── outbox/
│   │   │   ├── sync/
│   │   │   │   ├── services/
│   │   │   │   ├── repositories/
│   │   │   │   ├── processors/
│   │   │   │   └── clients/
│   │   │   └── local-reporting/
│   │   │
│   │   ├── contracts/
│   │   │   └── sync-event-v1.schema.json
│   │   │
│   │   └── openapi/
│   │
│   ├── docker/
│   │   ├── postgres/
│   │   │   └── init/
│   │   └── redis/
│   │       └── redis.conf
│   │
│   ├── scripts/
│   │   ├── migrate.sh
│   │   └── seed.sh
│   │
│   ├── test/
│   │   ├── unit/
│   │   ├── integration/
│   │   ├── e2e/
│   │   └── contract/
│   │
│   ├── Dockerfile                       # Outlet API and worker image
│   ├── .dockerignore
│   ├── .env.example
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   └── nest-cli.json
│
├── hq-frontend/                         # Independent HQ React application
│   │
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   │
│   │   ├── routes/
│   │   │
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── menu/
│   │   │   ├── assignments/
│   │   │   ├── outlets/
│   │   │   ├── reports/
│   │   │   └── sync/
│   │   │
│   │   ├── components/
│   │   │   ├── ui/
│   │   │   └── layout/
│   │   │
│   │   ├── api/
│   │   │   ├── axios.ts
│   │   │   ├── contracts/
│   │   │   │   └── hq.openapi.json
│   │   │   └── generated/
│   │   │
│   │   ├── lib/
│   │   │   ├── query-client.ts
│   │   │   ├── permissions.ts
│   │   │   └── utils.ts
│   │   │
│   │   ├── schemas/
│   │   ├── hooks/
│   │   ├── types/
│   │   └── assets/
│   │
│   ├── public/
│   │
│   ├── nginx/                          # HQ frontend's own Nginx
│   │   └── nginx.conf
│   │
│   ├── Dockerfile                      # React build + Nginx runtime
│   ├── .dockerignore
│   ├── .env.example
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── kubb.config.ts
│   └── index.html
│
├── outlet-frontend/                     # Independent Outlet React application
│   │
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   │
│   │   ├── routes/
│   │   │
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── pos/
│   │   │   ├── inventory/
│   │   │   ├── sales/
│   │   │   ├── receipts/
│   │   │   └── sync-status/
│   │   │
│   │   ├── components/
│   │   │   ├── ui/
│   │   │   └── layout/
│   │   │
│   │   ├── api/
│   │   │   ├── axios.ts
│   │   │   ├── contracts/
│   │   │   │   └── outlet.openapi.json
│   │   │   └── generated/
│   │   │
│   │   ├── lib/
│   │   │   ├── query-client.ts
│   │   │   ├── permissions.ts
│   │   │   └── utils.ts
│   │   │
│   │   ├── schemas/
│   │   ├── hooks/
│   │   ├── types/
│   │   └── assets/
│   │
│   ├── public/
│   │
│   ├── nginx/                          # Outlet frontend's own Nginx
│   │   └── nginx.conf
│   │
│   ├── Dockerfile                      # React build + Nginx runtime
│   ├── .dockerignore
│   ├── .env.example
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── kubb.config.ts
│   └── index.html
│
└── .github/
    └── workflows/
        ├── ci.yml
        ├── deploy-hq.yml
        └── deploy-outlet.yml
```

**Layered module rule:** Controller handles HTTP DTOs and guards; service owns authorization-independent business rules and transaction orchestration; repository encapsulates TypeORM queries and locking. A worker calls application services, not controllers. Repositories cannot make HTTP calls. Cross-module contracts use explicit interfaces and dependency injection. Use NestJS global `ValidationPipe` with whitelist + reject unknown fields + transformation; apply `class-validator`/DTOs on server, Zod for frontend input and response parsing. Do not trust frontend validation as a security control.

## 6. Data model and ownership

### 6.1 HQ PostgreSQL schema

All IDs are UUID unless otherwise specified. Typical audit columns: `created_at timestamptz NOT NULL`, `updated_at timestamptz NOT NULL`; `deleted_at` is nullable where soft deletion is appropriate.

| Table | Important fields | Constraints and purpose |
|---|---|---|
| `companies` | `id`, `name`, `currency_code` | V1 single company; future-ready scope. |
| `outlets` | `id`, `company_id`, `code`, `name`, `timezone`, `status`, `created_at` | FK company; UNIQUE(company_id, code); status ACTIVE/SUSPENDED. |
| `hq_users` | `id`, `company_id`, `email`, `password_hash`, `status` | UNIQUE(company_id, lower(email)); no plaintext secrets. |
| `hq_roles`, `hq_permissions`, `hq_user_roles`, `hq_role_permissions` | role/permission relationships | Unique composite mapping keys; permissions e.g. `menu.write`, `reports.read`. |
| `hq_refresh_sessions` | `id`, `user_id`, `family_id`, `jti`, `expires_at`, `revoked_at`, `rotated_at` | Indexed user/family, unique `jti`; refresh-JWT rotation and reuse response. |
| `menu_categories` | `id`, `company_id`, `name`, `sort_order`, `status` | FK company; UNIQUE(company_id, name). |
| `master_menu_items` | `id`, `company_id`, `category_id`, `sku`, `name`, `description`, `default_price_minor bigint`, `currency_code`, `status`, `version int` | UNIQUE(company_id, sku); CHECK(price >= 0); FK category; mutable catalog, immutable ID. |
| `outlet_menu_assignments` | `id`, `outlet_id`, `menu_item_id`, `price_override_minor bigint NULL`, `active boolean`, `version int` | UNIQUE(outlet_id, menu_item_id); CHECK(override >= 0); FKs; never hard-delete history. |
| `outlet_catalog_revisions` | `outlet_id`, `current_revision bigint` | One locked row per outlet; increment inside menu-change transaction. |
| `outlet_catalog_changes` | `id`, `outlet_id`, `revision bigint`, `action`, `payload jsonb`, `recorded_at` | UNIQUE(outlet_id, revision); changes include tombstones. |
| `outlet_api_keys` | `id`/`key_id`, `outlet_id`, `secret_hash`, `scopes text[]`, `status`, `expires_at`, `last_used_at`, `rotated_from_id` | Never store the raw secret; allow multiple overlapping active keys for rotation. |
| `sync_inbox_events` | `id`, `outlet_id`, `event_id`, `sequence_no bigint`, `event_type`, `payload_sha256`, `schema_version`, `status`, `received_at` | UNIQUE(outlet_id,event_id) and UNIQUE(outlet_id,sequence_no); replay detection. |
| `hq_sales` | `id`, `outlet_id`, `source_sale_id`, `receipt_no`, `sold_at`, `total_minor bigint`, `currency_code`, `status`, `ingested_at` | UNIQUE(outlet_id,source_sale_id), UNIQUE(outlet_id,receipt_no); immutable accepted sales projection. |
| `hq_sale_items` | `id`, `hq_sale_id`, `source_sale_item_id`, `menu_item_id`, `name_snapshot`, `quantity`, `unit_price_minor bigint`, `subtotal_minor bigint` | FK sale; UNIQUE(hq_sale_id,source_sale_item_id); preserve historical prices. |
| `hq_stock_snapshots` (optional V1.1) | `outlet_id`, `menu_item_id`, `quantity`, `source_version`, `observed_at` | Read-only projection, **not** HQ stock authority. |
| `sync_outlet_checkpoints` | `outlet_id`, `highest_contiguous_sequence`, `last_event_at`, `last_reported_backlog`, `last_menu_seen_revision` | Detect gaps and stale outlets. |
| `audit_logs` | `id`, `actor_type`, `actor_id`, `action`, `entity_id`, `metadata jsonb`, `occurred_at` | Immutable operations/security audit. |

### 6.2 Outlet PostgreSQL schema (one database for each outlet)

The outlet identity is provisioned once — through the setup wizard (UI pairing with HQ) or, for local development, a DB seed — and is checked against every worker event. An outlet never stores HQ-wide master catalog beyond items assigned to it.

| Table | Important fields | Constraints and purpose |
|---|---|---|
| `outlet_identity` | `outlet_id`, `outlet_code`, `company_id` (nullable), `timezone` (nullable), `currency_code` (nullable) | Singleton configuration; written once at wizard provisioning (informational columns nullable — currency backfilled from the first menu pull). |
| `hq_connection` | `outlet_id` (FK → `outlet_identity`), `hq_base_url`, `key_id`, `key_secret`, `last_validated_at`, `updated_at` | Singleton HQ pairing saved by the wizard (or rotated via `PUT /sync/hq-connection`); the worker's sole credential source. Raw secret lives only here — never in env vars, APIs or logs. |
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

**Minimum SQL-level protections:**

```sql
ALTER TABLE inventory_balances
  ADD CONSTRAINT inventory_nonnegative CHECK (quantity_on_hand >= 0);
ALTER TABLE sale_items
  ADD CONSTRAINT positive_line_quantity CHECK (quantity > 0),
  ADD CONSTRAINT nonnegative_line_price CHECK (unit_price_minor >= 0),
  ADD CONSTRAINT nonnegative_line_subtotal CHECK (subtotal_minor >= 0);
CREATE UNIQUE INDEX uq_hq_sale_source ON hq_sales(outlet_id, source_sale_id);
CREATE UNIQUE INDEX uq_hq_receipt ON hq_sales(outlet_id, receipt_no);
CREATE UNIQUE INDEX uq_hq_inbox_event ON sync_inbox_events(outlet_id, event_id);
CREATE UNIQUE INDEX uq_hq_inbox_sequence ON sync_inbox_events(outlet_id, sequence_no);
CREATE UNIQUE INDEX uq_outlet_event_seq ON outbox_events(outlet_id, sequence_no);
CREATE INDEX idx_outbox_due ON outbox_events(status, next_attempt_at)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX idx_hq_sales_reporting ON hq_sales(outlet_id, sold_at)
  WHERE status = 'COMPLETED';
CREATE INDEX idx_hq_sale_items_item ON hq_sale_items(menu_item_id, hq_sale_id);
CREATE INDEX idx_catalog_changes_cursor ON outlet_catalog_changes(outlet_id, revision);
```

Additional indexes: `master_menu_items(company_id,status,category_id)`, `outlet_menu_assignments(outlet_id,active)`, `stock_movements(menu_item_id,occurred_at DESC)`, `sales(sold_at DESC)`, `sync_inbox_events(outlet_id,received_at DESC)`, and case-insensitive user email uniqueness. Use actual migrations, not `synchronize: true`, in all environments.

**Entity rules:** No cross-database foreign key is possible between HQ and an outlet; carry UUID references and validate according to authority. FK local `sale_items.sale_id` to local `sales`, HQ `hq_sale_items.hq_sale_id` to HQ `hq_sales`. Store amounts as `bigint` in PostgreSQL, manipulate as `bigint` in TypeScript, serialize as canonical decimal strings, and reject unsafe/out-of-range values in DTOs.

## 7. HTTP API design and typed contracts

- HQ base URL: `https://hq.example.com/api/v1`.
- Outlet base URL: `https://outlet-a.example.local/api/v1` (site deployment may differ).
- Swagger: `/api/docs` in development/admin-restricted environments; machine-readable `/openapi.json` artifact in CI.
- JSON `Content-Type: application/json`; UTC ISO 8601 timestamps; IDs are UUIDs; `quantity` is integer; money strings use `^[0-9]+$` and are bounded to PostgreSQL `bigint`.
- Human endpoints use `Authorization: Bearer <access_jwt>`; machine sync endpoints use `Authorization: OutletKey <keyId>.<secret>` with appropriate key scopes.
- Every write accepts/returns `X-Request-Id`; client-created sale requires `Idempotency-Key`.
- Use stable error codes and correct 401/403/404/409/422/429/503 responses. Hide resources across unauthorized outlet scopes (404 or 403 according to policy, never leak content).

### 7.1 Response envelopes

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

**API response schema naming:** `CreateSaleRequest`, `SaleResponse`, `AssignMenuRequest`, `OutletMenuResponse`, `CatalogChangesResponse`, `EventBatchRequest`, `EventBatchResponse`, `CreateOutletIdentityRequest`, `SaveHqConnectionRequest`, `HqConnectionResponse`. Mark sensitive key issuance endpoints as internal/admin and never include secrets in generated frontend logs; the outlet setup endpoints are public only while unprovisioned and never echo the key secret.

### 7.2 HQ endpoints (human JWT)

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
| `GET` | `/audit/logs?cursor=&limit=&action=&actorId=&entityId=&from=&to=` | `audit.read` | Immutable audit trail listing (super admin only, FR-10). |

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

### 7.3 Outlet endpoints (outlet human JWT)

| Method | Route | Permissions | Purpose |
|---|---|---|---|
| `POST` | `/auth/login` | Public with rate limit | Outlet login. |
| `POST` | `/auth/refresh` | Refresh cookie/session | Rotate outlet refresh. |
| `POST` | `/auth/logout` | Authenticated | Revoke. |
| `GET` | `/setup/status` | Public | Terminal provisioning state (drives the setup wizard). |
| `POST` | `/setup/identity` | Public while unprovisioned, then sealed | Wizard step 1: save the HQ-issued outlet ID + code and create the first admin (one transaction; PRD §8.7). |
| `POST` | `/setup/hq-connection` | Public while unpaired, then sealed | Wizard step 2: validate the HQ machine key live (§9.2) and store the pairing. |
| `GET` | `/menu` | `menu.read` | Active, locally assigned menu with effective prices only. |
| `GET` | `/inventory` | `inventory.read` | Local balances. |
| `POST` | `/inventory/adjustments` | `inventory.adjust` | Audited local restock/write-off. |
| `POST` | `/sales` | `sales.create` | Multi-line atomic sale, idempotent. |
| `GET` | `/sales/:id` | `sales.read` | View receipt and historical lines. |
| `GET` | `/sales?from=&to=&cursor=` | `sales.read` | Local sale history. |
| `GET` | `/sync/status` | `sync.read` | Menu revision, last sync, pending/dead events, HQ pairing summary (key ID only). |
| `PUT` | `/sync/hq-connection` | `sync.manage` | Rotate the stored HQ machine key (validated live before saving; FR-10 switch-worker-secret step). |

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

**Insufficient stock:** HTTP `409` with `error.code = "INSUFFICIENT_STOCK"` and details `{menuItemId, requestedQuantity, availableQuantity}`; entire transaction is rolled back. `409 IDEMPOTENCY_KEY_REUSED` if same key is posted with a different canonical request payload. Validate at most e.g. 100 distinct items, max quantity per line, no unknown keys, and duplicate lines either reject or normalize consistently (V1: normalize by ID before hashing and validating).

### 7.4 HQ sync APIs (outlet key, no browser access)

| Method | Route | Key scope | Behavior |
|---|---|---|---|
| `GET` | `/sync/v1/menu/changes?afterRevision=42&limit=500` | `menu.pull` | Fetch only changes for authenticated outlet, ascending revision. |
| `GET` | `/sync/v1/menu/snapshot` | `menu.pull` | Consistent full catalog snapshot for bootstrap/gap recovery. |
| `POST` | `/sync/v1/events/batch` | `events.push` | Idempotent inbox ingestion with per-event acknowledgements. |
| `GET` | `/sync/v1/checkpoint` | `events.push` | Highest contiguous accepted outlet event sequence + missing ranges (reconciliation). |
| `POST` | `/sync/v1/heartbeat` | `status.write` | Optional diagnostics/backlog and local applied menu revision. |

**Important:** the HQ derives `outletId` exclusively from the key record; any `outletId` in a submitted event must match or the entire request is denied. Keys cannot use HQ administrative routes. Use TLS, IP allow-list where possible, rate limits, payload size limits, short request timeouts, and key rotation. A worker must not place keys in query strings, log messages, or frontend assets.

---

## 8. Synchronization contract and criteria

### 8.1 Data authority / synchronization matrix

| Data | Source of truth | Direction | Mechanism | Conflict policy |
|---|---|---|---|---|
| Master item details | HQ | HQ → outlet | Outlet pulls revisioned changes | HQ wins; apply by revision. |
| Outlet assignment/removal | HQ | HQ → outlet | Pull revisioned upsert/tombstone | HQ wins; remove from POS after application. |
| Effective outlet price | HQ | HQ → outlet | Pull item/assignment change | HQ wins for *future* sales only. |
| Local inventory quantity | Outlet | Optional outlet → HQ | Outbox stock adjustment / snapshot | Outlet wins; HQ projection read-only. |
| Completed sale + receipt | Outlet | Outlet → HQ | Transactional outbox → HTTP batch → HQ inbox | Event immutable; HQ deduplicates, never replaces. |
| Sale line price history | Outlet | Outlet → HQ | Included in `sale.completed` event | Stored as sold; never recompute using today's price. |
| Human users / refresh sessions | Their own backend | No sync | Local auth stores | Never cross-replicate credentials. |
| Outlet API key | HQ key registry | Provisioned securely to outlet worker | One-time secret distribution | HQ controls revocation. |

### 8.2 HQ menu change generation

1. HQ commits an item edit/assignment edit in a DB transaction.
2. For **each affected outlet**, lock its `outlet_catalog_revisions` row, increment revision, and append one canonical change entry describing the final outlet-specific effective item state (`UPSERT` or `REMOVE`); if a change affects 100 outlets, record per-outlet changes.
3. Return successful admin response only after menu mutation and all corresponding changes are committed atomically.
4. A change entry must be reproducible and schema-versioned. `UPSERT` includes all POS-needed fields, price override result, active status and item version; do not rely on fetching current master item state later to reconstruct an old delta.
5. For high fan-out, use transactional HQ change outbox + ordered fan-out processing and mark assignment distribution `PENDING` until all revisions are published; **do not** commit the admin change without any durable record of work to distribute it.

### 8.3 Menu changes request / response

```http
GET /api/v1/sync/v1/menu/changes?afterRevision=41&limit=500
Authorization: OutletKey ok_live_123.<redacted-secret>
```

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

**Pull algorithm:** Query `revision > local.last_applied_revision`, ascending; require contiguous revisions for the returned page (unless snapshot protocol explicitly handles compaction). Validate response with the versioned contract and verify outlet ID. Upsert/disable local catalog in a *single local transaction*, then set `last_applied_revision = nextRevision`. Do not advance the checkpoint before writes commit. If an HTTP request fails, leave checkpoint untouched. A repeated response must apply safely; revision lower than/equal to local applied revision is a no-op. If history is truncated or a gap is detected, fetch a consistent snapshot and replace catalog state atomically; do not infer removal from a missing page.

**Snapshot correctness:** Snapshot response includes `snapshotId`, `snapshotRevision`, pages/cursor, and a stable view for the snapshot lifetime. Download all pages to a staging table; after complete verification atomically swap/merge staging, mark absent items inactive, and set local revision to `snapshotRevision`. If snapshot expires mid-download, restart. Then resume changes **after** that exact revision; updates concurrent with snapshot are not lost.

### 8.4 Sale outbox event schema v1

Each committed sale emits one immutable `sale.completed` event. This is an example *inside the outbox payload* and then inside `events[]` on the HTTP sync call.

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

**Integrity invariants:** `sum(item.subtotalMinor) = totalMinor`; `quantity * unitPriceMinor = subtotalMinor`; event's outlet ID equals authenticated key outlet; sale is immutable and exactly one logical receipt belongs to `(outletId, receiptNo)`; `sequenceNo` originates from the same outlet DB transaction as the outbox row. Sync event schema upgrades use additive changes when possible and explicit supported versions. Unknown required versions are quarantined rather than silently ignored.

### 8.5 Push batch request and per-event acknowledgement

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

Possible event outcomes: `ACCEPTED`, `DUPLICATE`, `RETRYABLE_ERROR`, `REJECTED_PERMANENT`. A `DUPLICATE` has the **same canonical payload hash** as the accepted event and is terminal success. Reusing `(outletId,eventId)` or `(outletId,sequenceNo)` with *different* payload is `REJECTED_PERMANENT` plus security/audit alert; never overwrite original. `RETRYABLE_ERROR` is not acknowledged; retry that event. `REJECTED_PERMANENT` is quarantined at the outlet and must not be deleted; provide a manual repair/replay workflow. HTTP 200 may include mixed event statuses; HTTP 401/403/413/429/5xx applies to the batch/request and should be handled independently.

**Batch idempotency:** Preserve the same `batchId` and `Idempotency-Key` when retrying the *same bytes*. Event-level identity remains the ultimate deduplication key even if a worker later re-batches unacknowledged events. HQ may store a batch key + request hash to reject a changed payload with the same batch ID. Limit batch size (e.g. 100 events / 1 MiB) and split large backlogs.

### 8.6 Outbox / inbox algorithms

**Local sale transaction (outline; one QueryRunner/transaction manager):**

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

For high contention, use atomic conditional stock updates (`UPDATE ... SET quantity_on_hand = quantity_on_hand - $q WHERE menu_item_id = $id AND quantity_on_hand >= $q RETURNING ...`) within the same transaction; still use a **consistent per-item order** across all writes. Database uniqueness constraints and row locks, not a JavaScript mutex, are the final concurrency controls. Failed transaction retries must use the same client idempotency key.

**Outlet dispatcher/worker:**

```text
A. Periodic scanner leases due outbox rows with FOR UPDATE SKIP LOCKED.
B. Enqueue only event IDs to BullMQ; Redis jobs may be duplicated or lost.
C. Processor loads durable event and attempts authenticated HTTPS batch send.
D. Mark each ACCEPTED or identical DUPLICATE as DELIVERED in local DB.
E. For timeout/429/5xx, set RETRY with capped exponential backoff + jitter.
F. For permanent validation conflict, set QUARANTINED and alert operator.
G. Lease expiry returns stalled work to eligible retry; periodic scanner recovers
   after process/Redis crashes. Never mark delivered before HQ ack.
```

**HQ inbox transaction (per event):** authenticate outlet key → validate schema/version and outlet match → validate totals/identifiers → insert inbox event with unique event ID and immutable hash → insert sale header/lines projection (for `sale.completed`) → update contiguous sequence tracking if possible → commit → return ack. If duplicate ID and same hash, return `DUPLICATE` based on committed record. If transaction fails before commit, send retryable error. All event business effects and inbox deduplication must be in **one HQ PostgreSQL transaction**. Do not assume BullMQ's job ID deduplication replaces the database inbox.

### 8.7 Recovery, ordering, retention and reconciliation

- **Delivery:** at-least-once network delivery; effectively-once HQ side effects via idempotency and unique constraints. Never advertise exactly-once HTTP transport.
- **Ordering:** all outbound events carry per-outlet contiguous `sequenceNo`; HQ may ingest out of order. Track highest **contiguous** accepted sequence, not simply `MAX(sequenceNo)`. Do not block independent sale ingestion solely because an earlier event is delayed; account for gaps in reconciliation.
- **Retries:** bounded exponential backoff with jitter for 408/425/429/5xx/network faults; honor `Retry-After` when present; alert after configurable age/attempt threshold. Avoid 401 infinite retries: refresh/rotate machine key through a secure operator process.
- **Recovery:** periodic outbox scanner is required even if BullMQ scheduling succeeds; expired leases revert; crashed worker cannot make an event disappear.
- **Reconciliation:** worker calls HQ checkpoint, compares accepted sequences and local outbox, then selectively replays missing events. A daily reconciliation job compares outlet local completed sale count, total amounts and receipt range to HQ projections for an agreed UTC/date window. Alert on mismatch; never auto-insert fabricated sales.
- **Retention:** keep sales and receipt records as required by legal policy; keep inbox dedupe records for at least the full replay/archive horizon (recommended effectively permanent compact identity/hash). Retain outbox delivered rows until reconciliation/archive policies guarantee safe replay.
- **Status:** separate `sale.status=COMPLETED` from `sale.sync_status=PENDING|DELIVERED|QUARANTINED`; sync is not a second sale completion step.
- **Bootstrapping:** a new outlet terminal provisions itself through the setup wizard (§7.3): paste the HQ-issued outlet ID + site code (step 1, creating the first admin in the same transaction), then paste the one-time machine key which is validated live against HQ before the pairing is saved (step 2, `hq_connection`). The worker then performs a full catalog snapshot, staff provision inventory through the audited adjustment flow, and cashier sales begin.

### 8.8 Offline policy and critical consistency trade-off

**Unavoidable constraint:** when an outlet is disconnected from HQ, it cannot know that HQ just revoked an item or changed its price. Therefore the platform cannot simultaneously guarantee unrestricted offline sales **and** immediate global enforcement of HQ changes.

**V1 policy:** outlet may sell only locally active, last-synchronized assigned items while disconnected for up to a configurable grace period (proposed 72 hours); after expiry, block new sales until menu sync succeeds or a privileged, audited emergency override is applied. Every sale records its `catalogRevision` and local `soldAt`. Upon reconnection, HQ accepts historically valid completed sales as immutable source events, subject to anti-fraud/identity checks, and flags any catalog revision/price disagreement for audit instead of changing receipt prices or silently deleting sales. A product removal takes effect locally once its `REMOVE` revision is applied. A business needing *immediate* HQ revocation must configure **online-only** sale authorization instead.

**Clock security:** do not depend solely on the outlet's wall clock for fraud detection; report drift, keep `created_at`/`received_at` and event sequence, and use NTP. The grace policy uses monotonic/last-success state where available, with restart-safe local timestamps and audit.

---

## 9. Authentication, API key lifecycle and RBAC

### 9.1 Human JWT session model

- Separate `HQ_JWT_ISSUER/AUDIENCE` and `OUTLET_JWT_ISSUER/AUDIENCE`. Each backend signs both token kinds with NestJS Passport/`@nestjs/jwt` using two independent HS256 secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` for HQ; `OUTLET_JWT_ACCESS_SECRET`, `OUTLET_JWT_REFRESH_SECRET` for the outlet) so one leaked secret can never forge the other token kind; the access strategy reads the bearer header, the refresh strategy reads the HttpOnly cookie.
- Access token lifetime target **10–15 minutes**. Claims include `sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `scope`/role IDs and outlet ID for outlet tokens. Recheck user active status and high-impact permissions against server state or short-lived cache to enforce revocations promptly.
- Refresh token: signed refresh JWT (own secret, distinct `jti` per issuance), rotated on each refresh, with every `jti` tracked server-side in the refresh-session table (rotation state, expiry, family, revocation); browser holds it in an `HttpOnly`, `Secure`, suitable `SameSite` cookie with CSRF protections. Avoid localStorage for refresh tokens. Signature checks alone never authorize a refresh — the `jti` must resolve to a live, unrotated, unrevoked row.
- Passwords: Argon2id/bcrypt with strong parameters; login rate limits/lockout; audit log for sign-in, refresh reuse and permission changes.
- `POST /auth/refresh` must serialize rotation or use a compare-and-swap on the session row's rotation state; a stolen/reused old `jti` invalidates its refresh family; allow only a narrowly designed race grace if necessary.

**Login response:**

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

Refresh token is set in an HTTP-only cookie, **not** returned in this JSON example.

### 9.2 Machine outlet API keys

- HQ generates 256-bit cryptographically random secret with nonsecret `keyId`; show raw key **once** to an authorized HQ admin/secure provisioning channel.
- Store indexed `keyId` plus a server-side keyed digest or strong secret hash, not plaintext; compare in constant time; protect hash pepper in a secret manager.
- Key maps to exactly one `outlet_id` and narrow `menu.pull`, `events.push`, `status.write` scopes. Use separate read and write keys if operational policy demands it.
- On rotation, create a replacement key with time-limited dual validity; switch worker secret, confirm `last_used_at`, then revoke old key. Revocation blocks new sync calls but cannot retroactively change accepted sales.
- Require TLS; mTLS is recommended for higher assurance. Rate-limit and cap body sizes per key; do not allow CORS browser access to sync endpoints. Reject `outletId` mismatch.

### 9.3 Example permission matrix

| Action | HQ Super Admin | HQ Menu Manager | HQ Analyst | Outlet Manager | Cashier | Inventory Clerk |
|---|---|---|---|---|---|---|
| Edit master menu | Yes | Yes | No | No | No | No |
| Assign/price menu | Yes | Yes | No | No | No | No |
| Manage outlet API keys | Yes | No | No | No | No | No |
| Read cross-outlet reports | Yes | Optional | Yes | No | No | No |
| Read audit trail | Yes | No | No | No | No | No |
| Read assigned local menu | No | No | No | Yes | Yes | Yes |
| Create local sale | No | No | No | Yes | Yes | No |
| Adjust local stock | No | No | No | Yes | No | Yes |
| Read local sales | No | No | No | Yes | Yes (scope-limited) | No |
| Rotate the outlet's stored HQ key (`sync.manage`) | No | No | No | Yes | No | No |

No frontend route hiding is considered sufficient authorization; always enforce backend guards and ownership checks.

## 10. Reporting definitions

**Revenue by outlet** counts locally `COMPLETED` sales successfully accepted into HQ `hq_sales`, summed from immutable `total_minor`. Reporting filter `from` inclusive and `to` exclusive, UTC unless an explicit outlet-local business-day mode is requested. Optional currency filter; do not sum unlike currencies without explicit FX conversion (V1 uses one company currency). A missing outlet contribution may mean unsynced sales, not zero.

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

**Top items per outlet** groups `hq_sale_items` by stable `menu_item_id`, sums quantity, orders `quantitySold DESC`, then menu ID as deterministic tie-break; excludes void/refund adjustments until separate compensating events are implemented.

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

## 11. Frontend product scope

**HQ frontend:** login; dashboard (revenue, lag, outlet health); master categories and menu CRUD; assignment matrix by outlet; override editor with effective-price preview; outlet/key lifecycle administration (show secret one time); reports with date filters and `dataAsOf`; sync-health panel; audit views. Use TanStack Router protected route layouts and Zod-validated query/search params. Generate typed Axios API functions, TypeScript DTOs, Zod validation schemas and TanStack Query helpers from the HQ OpenAPI contract via Kubb; do not manually maintain conflicting API types.

**Outlet frontend:** local login; responsive POS menu/cart; live stock availability; checkout with stable client idempotency key across retries; receipt detail/reprint; inventory adjustment with audit reason; local sales history; last menu sync / pending upload banner. Use TanStack Router and Query, with optimistic UI only for non-financial actions. Stock/sale confirmation must use authoritative backend response, not a local optimistic decrement. On network failure between browser and *local backend*, retry the same `Idempotency-Key` (never mint a second key for the same attempted sale).

**Kubb generation pipeline:** export HQ and outlet OpenAPI documents from NestJS in CI; verify schema diff against backward compatibility rules; generate separate clients under each frontend `src/api/generated/` using Kubb TS + Axios + Zod + React Query plugins. The outlet backend generates or uses a typed **machine client** for the HQ sync endpoints, with the outlet key resolved server-side from the `hq_connection` table (setup wizard / rotation route) — never in environment variables or frontend code. Commit generated artifacts consistently or generate in deterministic CI; block merges when generation is stale. Exact Kubb plugin configuration must be pinned to a tested compatible version in `pnpm-lock.yaml`.

## 12. Validation and error handling

| Layer | Rules |
|---|---|
| Frontend | Zod forms, search params, meaningful inline error messages; parse high-risk API responses. |
| Controller | Nest DTO validation; forbid unknown properties, sanitize strings, max payload size, UUID/ISO/date validation. |
| Service | Business rules: assigned menu, price resolution, currency, stock, totals, outlet isolation. |
| Repository/DB | FK, UNIQUE, CHECK, transactions, row locks, index-backed queries. |
| Worker | Validate envelopes, versions, checksum, HTTP status + per-event ACK; retry safely. |
| HQ ingest | Verify key/outlet, schema and totals; transactional inbox, immutable projection, reject conflicts. |

**Standard error codes:** `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `ITEM_NOT_ASSIGNED`, `ITEM_INACTIVE`, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_KEY_REUSED`, `RECEIPT_CONFLICT`, `EVENT_ID_CONFLICT`, `UNSUPPORTED_EVENT_VERSION`, `MENU_SNAPSHOT_REQUIRED`, `SYNC_TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`.

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

## 13. Worker, queue and operational design

**Redis/BullMQ:** maintain separate HQ and outlet Redis namespaces/instances and queues. Outlet queues: `menu-pull`, `outbox-dispatch`, `sync-delivery`, `sync-reconcile`; HQ queues: `report-refresh` (optional), `catalog-fanout` (if fan-out asynchronous), `audit-cleanup`. Jobs include IDs and look up DB records; queue payloads do **not** contain bearer credentials or full PII-heavy sale details. Configure concurrency carefully; BullMQ retries are an execution optimization, not a transactional store. Use repeatable/polling scheduler for menu pull and outbox sweeper, with startup scans and distributed singleton locking for scheduled tasks where appropriate.

**Sample starting schedules (configurable):** menu pull every 30 seconds while online; outbox sweep every 5 seconds; heartbeat every 60 seconds; checkpoint reconciliation hourly plus daily deep reconciliation. These are proposed defaults, not hard business guarantees. Retry transient delivery up to alert threshold and continue via durable recovery; no permanent event loss.

**Monitoring:** OpenTelemetry traces across HTTP → service → DB → outbox / worker → HQ API; structured JSON logs with `requestId`, `outletId`, `eventId`, `saleId`, `receiptNo`, `revision` (avoid sensitive data). Metrics: `outbox_pending_count`, `oldest_pending_age_seconds`, `sync_delivery_success_rate`, `sync_api_latency`, `menu_revision_lag`, `inbox_duplicates_total`, `sync_quarantined_count`, `hq_reporting_lag_seconds`, `sale_transaction_latency`, `stock_conflicts_total`. Alert on key revocation, stuck backlog, snapshot errors, missing sequence, and reporting discrepancies.

## 14. Configuration and deployment

### 14.1 Environment variables (examples only)

| HQ backend | Outlet backend | Frontends |
|---|---|---|
| `NODE_ENV`, `PORT`, `DATABASE_URL` | `NODE_ENV`, `PORT`, `DATABASE_URL` | `VITE_API_BASE_URL` |
| `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | `REDIS_URL`, `OUTLET_JWT_ACCESS_SECRET`, `OUTLET_JWT_REFRESH_SECRET` | No machine secrets |
| `HQ_JWT_ISSUER`, `HQ_JWT_AUDIENCE` | `OUTLET_JWT_ISSUER`, `OUTLET_JWT_AUDIENCE` | Build-time public config only |
| `OUTLET_KEY_PEPPER`, `CORS_ORIGINS` | `CORS_ORIGINS`, `SYNC_MAX_BODY_BYTES` | Frontend app version |
| `LOG_LEVEL`, `SYNC_MAX_BODY_BYTES` | `MENU_PULL_INTERVAL_MS` | — |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | `OUTBOX_BATCH_SIZE`, `OUTBOX_SWEEP_INTERVAL_MS`, `OFFLINE_GRACE_HOURS` | — |
| `APP_ENTRYPOINT` (`api`/`worker`), `HEARTBEAT_INTERVAL_MS` (worker) | `APP_ENTRYPOINT` (`api`/`worker`), `HEARTBEAT_INTERVAL_MS` (worker) | — |

Both backends load and validate configuration with **Zod + `@nestjs/config`** (implemented in Phase 0): `src/config/env.schema.ts` defines the schema and the `Env` type; the global `src/config/configuration.module.ts` wires `ConfigModule.forRoot({ isGlobal: true, cache: true, validate, envFilePath: ['.env.local', '.env'] })`; every module reads typed values through `ConfigService<Env, true>` with `config.get('KEY', { infer: true })`.

`APP_ENTRYPOINT` (`api` | `worker`) selects the **validation profile**: the `api` profile requires that backend's JWT secrets, while the `worker` profile requires only worker credentials (HQ worker: nothing beyond the base schema; outlet worker: nothing beyond the base schema either — its HQ base URL and machine key are **not environment inputs**, they arrive through the setup wizard and live in the `hq_connection` table, §8.7/§9.2). Neither entrypoint can therefore be provisioned with the other's secrets (§3, §9.2). Each entrypoint validates and pins its profile before the Nest module graph loads; missing or inconsistent critical values fail startup with a structured fatal log. Environment precedence: real environment variables win over `.env.local`, which wins over `.env`.

Load secrets from a managed secret store or mounted secrets in production; `.env.example` holds placeholders only. CORS allows only each app's own UI origin. Set secure HTTP headers, HTTPS termination, trusted proxy settings, and per-environment DB credentials. Production deployments use independent PostgreSQL/Redis volumes, backups and observability.

### 14.2 Docker artifacts

Each backend has a multi-stage `Dockerfile` with distinct `api` and `worker` commands/targets; frontends use multi-stage Vite build and static reverse proxy serving. All images run non-root with health checks and pinned base-image digest in production. Do not embed environment secrets in Docker build layers or Vite bundle. Database migration is a **single controlled release job**, never concurrently on every API replica.

**Required local development `docker-compose.yml` services:**

```yaml
services:
  hq-db:            # postgres: HQ volume/network/healthcheck
  hq-redis:         # redis: HQ workers/queue
  hq-api:           # apps/hq-backend Dockerfile, API entrypoint
  hq-worker:        # same HQ image, worker entrypoint
  hq-web:           # apps/hq-frontend static web
  outlet-a-db:      # separate postgres database + volume
  outlet-a-redis:   # separate redis queue
  outlet-a-api:     # apps/outlet-backend, identity via setup wizard
  outlet-a-worker:  # outlet sync worker, HQ key from secret
  outlet-a-web:     # apps/outlet-frontend static web
```

**Production topology:** deploy HQ compose/cluster centrally. Deploy `docker-compose.outlet.yml` **once per outlet site**, each with its own DB volume, Redis, API, worker, UI and protected outbound HTTPS to HQ. The dev sample has one outlet A but the system supports N independent sites. Network policy should ensure HQ has no inbound route to outlet DB. No container depends on HQ API reachability to complete an outlet sale.

### 14.3 Backup, migrations and releases

Version all TypeORM migrations per backend; never share a single migration folder or database. Use expand–migrate–contract rollouts for changes to event envelopes and menu deltas; HQ ingest supports at least the currently deployed outlet event version during rolling upgrades. Encrypt PostgreSQL backups, test restores, define recovery objectives, and maintain outlet restore behavior that does not reuse prior receipt numbers or re-send event IDs with altered payloads. For disaster recovery, restore outbox and receipt counter consistently from the **same local DB backup**.

## 15. Security and resilience requirements

- HTTPS required for all requests, preferably mTLS for site-to-HQ sync; key rotation/revocation and audit are mandatory.
- No direct HQ ↔ outlet DB sharing and no shared session cookies across HQ/outlet domains.
- Validate `outletId` against token/key identity and enforce company/outlet scope in all repositories.
- Prevent SQL injection with TypeORM parameters, avoid unbounded queries and `synchronize: true`.
- Never trust client-submitted prices, totals, receipts, or sale timestamps as authoritative when the backend can compute them. Outlet backend generates authoritative `soldAt`.
- Secrets/password hashes/refresh tokens/API keys never appear in logs or generated clients.
- PII minimization, local data retention and access audit; configure backups, encryption, key management and security review.
- Rate-limit login and machine endpoints, cap body size, set timeouts and circuit breakers.
- Database transactions must have bounded lock wait/statement timeouts and deterministic lock ordering.
- Outbox reconciler can restore from network, API, worker or Redis outages without losing committed sales.

## 16. Nonfunctional targets (initial service objectives)

| Measure | Proposed target / test |
|---|---|
| Local sale API latency | p95 < 500 ms in normal site LAN for ≤10 items (benchmark hardware first). |
| Inventory and receipts | 0 oversells and 0 duplicate receipt numbers in concurrency tests. |
| Sync recovery | 99% of pending events delivered within 2 minutes **after connectivity is restored**, absent HQ incident/backpressure. |
| Menu freshness | Changes visible at connected outlets within 60 seconds under normal load with 30s polling. |
| Durable delivery | No committed sale can exist without its outbox row; no ACK without HQ inbox/projection commit. |
| HQ report clarity | Explicit data freshness, not misleading real-time guarantee. |
| Operational recovery | Document and test DB backup/restore, key rotation and dead-letter replay. |
| Accessibility | Keyboard accessible POS workflows, visible errors and readable contrast. |

These are design targets subject to performance tests and infrastructure sizing; they are not existing measured guarantees.

## 17. Test strategy and acceptance scenarios

| ID | Scenario | Expected result |
|---|---|---|
| AT-01 | HQ assigns item only to A and B | A/B eventually receive item; C never receives or sells it. |
| AT-02 | HQ B price override $12 vs default $10 | B prices new sales at $12; existing sale snapshots unchanged. |
| AT-03 | Sale 2 burgers + 1 pizza | Correct computed totals, stock movements, one receipt and one outbox event. |
| AT-04 | Any line lacks stock | 409; no sale, stock delta, receipt increment or event. |
| AT-05 | Two simultaneous purchases of last unit | Exactly one success; stock remains ≥ 0. |
| AT-06 | 100 concurrent sales at same outlet | Distinct sequential committed receipts; no duplicates; row lock protects counter. |
| AT-07 | Repeat same POST with same idempotency key | Same sale/receipt returned; no second deduction/event. |
| AT-08 | Same idempotency key, altered body | 409; original sale unchanged. |
| AT-09 | Worker crashes after HQ commit before local ACK | Retry returns DUPLICATE; one HQ sale and projection. |
| AT-10 | Redis unavailable after sale commit | Sale still commits; periodic outbox scanner resumes once Redis returns. |
| AT-11 | Outlet offline 24 hours | Local permitted sales continue; ordered outbox backlog is delivered after reconnect. |
| AT-12 | HQ unassigns item during outage | Old local menu may sell until sync; after REMOVE applied, new sale denied; exceptions audited. |
| AT-13 | Menu page application crashes | Transaction rolls back; cursor not advanced; safe retry. |
| AT-14 | Catalog history gap requires snapshot | Atomic staging/replacement catches up to revision without losing concurrent changes. |
| AT-15 | Event replay with same ID + different payload | Rejected and flagged; accepted event not overwritten. |
| AT-16 | API key for outlet A requests B data | Denied; no B rows leaked. |
| AT-17 | Cashier tries HQ menu admin route | JWT/issuer/permission denied. |
| AT-18 | Old refresh token reused after rotation | Token family revoked and audited. |
| AT-19 | HQ changes price after synced sale | Past receipt and revenue preserve prior unit price. |
| AT-20 | HQ reporting during outlet backlog | Reports disclose stale ingestion timestamp/watermark. |
| AT-21 | Duplicate or out-of-order event sequences | No duplicate business effects; contiguous checkpoint advances only when gaps filled. |
| AT-22 | Local DB restore + replay | Receipt counter and outbox remain consistent; resends deduplicated by HQ. |

**Testing layers:** Jest unit tests for services and guards; integration tests against **real PostgreSQL and Redis** via containers (SQLite is insufficient for row-lock behavior); API/contract tests for OpenAPI and event v1; concurrency stress with parallel clients; property-based money/quantity tests; end-to-end browser tests; network partition and crash injection. CI runs migrations on fresh databases and verifies generated Kubb clients are current.

## 18. Implementation roadmap and deliverables

**Phase 0 – Foundation:** Under fnb-platform folder the four app shells, strict TS, lint/format, env validation, separate Postgres/Redis, Dockerfiles, compose, database migration pipeline, OpenAPI export, logging.

**Phase 1 – Security / HQ catalog:** HQ JWT + rotating refresh, HQ users/RBAC, outlets, master menu CRUD, assignments and prices, outlet key issuance/rotation, per-outlet catalog revisions and changes.

**Phase 2 – Outlet operations:** outlet JWT/RBAC, catalog cache, inventory balances/movements, atomic multi-item sale, receipt counter, idempotent sale API, transactional outbox and local POS/inventory UI.

**Phase 3 – Synchronization:** typed HQ sync client, pull deltas/snapshot, BullMQ dispatcher/workers, HQ transactional inbox ingestion, per-event ACKs, retries, reconciliation, status and alerting, offline policy.

**Phase 4 – Reporting / hardening:** revenue/top items, staleness indicators, admin dashboards, audit, cross-outlet security tests, load/concurrency/failure tests

**Definition of done:** all AT-01 to AT-22 pass; API docs and generated clients match; production migrations and Docker deployment work; no leaked secrets; observability dashboards and on-call runbook exist; a failed/duplicate sync cannot double-count HQ revenue.


## 19. Implementation reference material

- NestJS official OpenAPI integration: https://docs.nestjs.com/openapi/introduction
- TypeORM official transactions: https://typeorm.io/docs/advanced-topics/transactions/
- BullMQ idempotent job guidance: https://docs.bullmq.io/patterns/idempotent-jobs
- Kubb TypeScript/Axios/Zod plugin guidance: https://kubb.dev/extensions/kubb-labs/plugin-axios
- TanStack Router typed search/validation: https://tanstack.com/router/latest/docs/how-to/validate-search-params

