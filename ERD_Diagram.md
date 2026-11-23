# ERD — fnb-platform Database Schemas (ASCII)

Entity-relationship diagrams for the two independent PostgreSQL schemas in this
platform, drawn in **plain ASCII** so they render in *any* Markdown preview — no
extensions or Mermaid support required.

- **HQ database** (`fnb_hq`) — master catalog, outlets, assignments, sync keys,
  sale projections, audit.
- **Outlet database** (`fnb_outlet_a`, one per site) — local identity, catalog
  cache, stock, sales/receipts, transactional outbox.

Source of truth: the TypeORM migrations in `hq-backend/src/database/migrations/`
and `outlet-backend/src/database/migrations/`.

## How to read the diagrams

| Notation | Meaning |
|---|---|
| `PK` / `FK` / `UK` | Primary key / **enforced** foreign key (same database) / unique key |
| `▸` | Logical UUID reference only — no FK, validated by application logic |
| `┄┄►` | Dashed connector = logical reference (no enforced FK) |
| `1:*` / `1:0..1` | One-to-many / zero-or-one (singleton row) |
| `*_minor` (bigint) | Money in integer minor units, serialized as decimal strings |

Generic `created_at` / `updated_at` audit timestamps exist on most tables and are
omitted from the boxes for readability. `UK*` marks one half of a composite
unique constraint (the other half is the parent key).

---

## 1. HQ database (`fnb_hq`)

### 1.0 Overview map

```
┌─────────────────────┐
│ companies           │
└──────┬───────┬──────┘
       │ 1:*   └──────────────┐
       ▼                      ▼
┌─────────────┐   ┌──────────────────────────────────────────────┐
│ hq_users    │   │ outlets (sync hub)                           │
│ hq_roles    │   │ ── 1:0..1  outlet_catalog_revisions          │
│ hq_perms    │   │ ── 1:*     outlet_catalog_changes            │
│ sessions    │   │ ── 1:*     outlet_api_keys (self-rotating)   │
│ user_roles  │   │ ── 1:*     sync_inbox_events                 │
│ role_perms  │   │ ── 1:0..1  sync_outlet_checkpoints           │
└─────────────┘   │ ── 1:*     hq_sales ──< hq_sale_items        │
                  └──────────────────────────────────────────────┘
menu_categories ──< master_menu_items ──< outlet_menu_assignments (>── outlets)
audit_logs — standalone (actor_id / entity_id are logical, no FK)
```

### 1.1 Staff, RBAC and sessions

```
┌─────────────────────┐                       ┌─────────────────────┐
│ hq_users            │                       │ hq_roles            │
│ PK id               │                       │ PK id               │
│ UK email            │                       │ FK company_id       │
│    password_hash    │                       │ UK code             │
│    status           │                       │    name             │
└──────────┬──────┬───┘                       └────┬─────────┬──────┘
           │      │ 1:*                      1:*   │         ▼
           │ 1:*  └──────────┐             (join)  │  ┌─────────────────────┐
           ▼                 │                     │  │ hq_role_permissions │
┌─────────────────────┐      │                     │  │ PK role_id (FK)     │
│ hq_refresh_sessions │      │                     │  │ PK permission_id FK │
│ PK id               │      │                     │  └──────────┬──────────┘
│ FK user_id          │      │                     │          1:*│
│    family_id        │      │                     │             ▼
│ UK jti              │      │                     │  ┌─────────────────────┐
│    expires_at       │      │                     │  │ hq_permissions      │
│    revoked_at       │      │                     │  │ PK id               │
│    rotated_at       │      │                     │  │ UK code             │
└─────────────────────┘      │                     │  │    description      │
                             │                     │  └─────────────────────┘
                             │                     │
                          *  │                   * │
                             ▼                     ▼
           ┌─────────────────────────────────────────────┐
           │ hq_user_roles                               │
           │ PK user_id (FK)                             │
           │ PK role_id (FK)                             │
           └─────────────────────────────────────────────┘

FK company_id on hq_users / hq_roles ▸ companies.id (overview map 1.0)
```

### 1.2 Catalog and per-outlet distribution

```
┌─────────────────────┐                       ┌─────────────────────┐
│ companies           │                       │ outlets             │
│ PK id               │                       │ PK id               │
│    name             │      owns 1:*         │ FK company_id       │
│    currency_code    ├──────────────────────►│ UK code             │
└──────────┬──────────┘                       │    name             │
           │             ┌──────1:*───────────┤    timezone         │
           │ 1:*         │                    │    status           │
           │(company_id) │                    └────┬───────────┬────┘
           ▼             │              1:0..1     │        1:*│
┌─────────────────────┐  │                         ▼           └────┐
│ menu_categories     │  │     ┌─────────────────────┐              │
│ PK id               │  │     │ outlet_catalog_     │              │
│ FK company_id       │  │     │ revisions           │              │
│    name             │  │     │ PK outlet_id (FK)   │              │
│    sort_order       │  │     │    current_revision │              │
│    status           │  │     └─────────────────────┘              │
└──────────┬──────────┘  │                                          │
           │             │                                          │
           │ 1:*         │                                          │
           ▼             │            ┌─────────────────────┐       │
┌─────────────────────┐  │            │ outlet_catalog_     │       │
│ master_menu_items   │  │            │ changes             │       │
│ PK id               │  │            │ PK id               │       │
│ FK category_id      │  │            │ FK outlet_id        │       │
│    sku              │  │            │ UK* revision        │       │
│    name             │  │            │    action           │       │
│    default_price_   │  │            │    payload (jsonb)  │       │
│       minor         │  │            │    recorded_at      │       │
│    status           │  │            └─────────────────────┘       │
│    version          │  │
└──────────┬──────────┘  │
           │             │
           │ 1:*         │
           └──────┐      │
                  ▼      ▼
┌───────────────────────────────────────────────────────┐
│ outlet_menu_assignments                               │
│ PK id                                                 │
│ FK outlet_id      (side path from outlets, 1:*)       │
│ FK menu_item_id   (from master_menu_items, 1:*)       │
│    price_override_minor (nullable)                    │
│    active (false = soft-unassign)                     │
│    version                                            │
└───────────────────────────────────────────────────────┘
UNIQUE (outlet_id, menu_item_id)
effective price = price_override_minor ?? master default
```

### 1.3 Machine keys and sync ingest

```
┌─────────────────────┐
│ outlets             │
│ PK id               │
│ FK company_id       │
│ UK code             │
│    name             │
│    timezone         │
│    status           │
└──────────┬──────────┘
           │ 1:* (outlet_id)
           ▼
┌─────────────────────┐
│ outlet_api_keys     │
│ PK id               │
│ UK key_id           │
│ FK outlet_id        │
│    secret_hash      │
│    scopes           ├────────┐ 1:* self-reference
│    status           │        │ (rotated_from_id)
│    expires_at       │        │
│ FK rotated_from_id  │◄───────┘
└─────────────────────┘

┌─────────────────────┐
│ outlets             │
│ (hub, repeated)     │
└───────┬─────────┬───┘
        │         │
   1:*  │         │ 1:0..1
        ▼         ▼
┌─────────────────────┐   ┌─────────────────────────┐
│ sync_inbox_events   │   │ sync_outlet_checkpoints │
│ PK id               │   │ PK outlet_id (FK)       │
│ FK outlet_id        │   │    highest_contiguous_  │
│ UK* event_id        │   │       sequence          │
│ UK* sequence_no     │   │    last_event_at        │
│    event_type       │   │    last_reported_       │
│    payload_sha256   │   │       backlog (jsonb)   │
│    schema_version   │   │    last_menu_seen_      │
│    status           │   │       revision          │
│    received_at      │   │    last_heartbeat_at    │
└─────────────────────┘   └─────────────────────────┘
 UNIQUE (outlet_id, event_id)
 UNIQUE (outlet_id, sequence_no)

┌─────────────────────┐
│ audit_logs          │    Standalone — no enforced FK.
│ PK id               │    actor_id / entity_id are logical
│    actor_type       │    references (USER | OUTLET_KEY |
│ ▸ actor_id          │    SYSTEM) resolved by application
│    action           │    logic.
│ ▸ entity_type/id    │
│    metadata (jsonb) │
│    occurred_at      │
└─────────────────────┘

┌─────────────────────┐
│ outlets             │
│ (hub, repeated)     │
└──────────┬──────────┘
           │ 1:* (outlet_id)
           ▼
┌─────────────────────┐
│ hq_sales            │
│ PK id               │
│ FK outlet_id        │
│ ▸ source_sale_id    │
│    receipt_no       │
│    sold_at          │
│    total_minor      │
│    currency_code    │
│    status           │
│    ingested_at      │
└──────────┬──────────┘
           │ 1:* (hq_sale_id, ON DELETE CASCADE)
           ▼
┌─────────────────────┐
│ hq_sale_items       │
│ PK id               │
│ FK hq_sale_id       │
│ ▸ source_sale_item_ │
│       id            │
│ ▸ menu_item_id      │
│    name_snapshot    │
│    quantity         │
│    unit_price_minor │
│    subtotal_minor   │
└─────────────────────┘
```

---

## 2. Outlet database (`fnb_outlet_a`, one per site)

### 2.0 Overview map

```
┌───────────────────────────────────────────────────────────────────────┐
│ outlet_identity (singleton, written once by the setup wizard)         │
│    · 1:0..1 ── hq_connection (HQ base URL + machine key)              │
│    · 1:*    ── sales ──< sale_items / sale_idempotency_keys           │
│    · 1:*    ── outbox_events ──< sync_attempt_logs                    │
│    · singletons keyed by outlet_id (no FK): menu_sync_state,          │
│      receipt_counters, outbox_counters                                │
│                                                                       │
│ STAFF & RBAC                                                          │
│    · outlet_users ─< outlet_refresh_sessions / outlet_audit_logs      │
│    · outlet_users + outlet_roles ─< outlet_user_roles                 │
│    · outlet_roles ─< outlet_role_permissions ─< outlet_permissions    │
│                                                                       │
│ CATALOG & STOCK                                                       │
│    · catalog_items ──0..1── inventory_balances                        │
│    · catalog_items ──< stock_movements (append-only ledger)           │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.1 Terminal identity and HQ pairing

```
┌─────────────────────┐
│ outlet_identity     │
│ PK outlet_id        │
│ UK outlet_code      │
│ ▸ company_id        │
│    timezone         │
│    currency_code    │
└──────────┬──────────┘
           │ 1:0..1 (paired once via setup wizard)
           ▼
┌─────────────────────┐
│ hq_connection       │
│ PK outlet_id (FK)   │
│    hq_base_url      │
│    key_id           │
│    key_secret       │
│    last_validated_  │
│       at            │
└─────────────────────┘

Singletons keyed by outlet_id — no FK, one row each
(written by the setup wizard / sync worker / sale transaction):

┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ menu_sync_state     │  │ receipt_counters    │  │ outbox_counters     │
│ PK outlet_id        │  │ PK outlet_id        │  │ PK outlet_id        │
│    last_applied_    │  │    next_number      │  │    next_sequence    │
│       revision      │  │    prefix           │  └─────────────────────┘
│    last_sync_at     │  └─────────────────────┘
│    snapshot_id      │
│    grace_overridden_│
│       until         │
└─────────────────────┘
```

### 2.2 Staff, RBAC and sessions

```
┌─────────────────────┐                       ┌─────────────────────┐
│ outlet_users        │                       │ outlet_roles        │
│ PK id               │                       │ PK id               │
│ UK email            │                       │ UK code             │
│    password_hash    │                       │    name             │
│    status           │                       └────┬─────────┬──────┘
└──────────┬──────┬───┘                         1:*│         ▼
           │      │ 1:*                    (join)  │  ┌─────────────────────┐
           │ 1:*  └──────────┐                     │  │ outlet_role_        │
           ▼                 │                     │  │ permissions         │
┌─────────────────────┐      │                     │  │ PK role_id (FK)     │
│ outlet_refresh_     │      │                     │  │ PK permission_id FK │
│ sessions            │      │                     │  └──────────┬──────────┘
│ PK id               │      │                     │          1:*│
│ FK user_id          │      │                     │             ▼
│    family_id        │      │                     │  ┌─────────────────────┐
│ UK jti              │      │                     │  │ outlet_permissions  │
│    expires_at       │      │                     │  │ PK id               │
│    revoked_at       │      │                     │  │ UK code             │
│    rotated_at       │      │                     │  │    description      │
└─────────────────────┘      │                     │  └─────────────────────┘
                             │                     │
                          *  │                   * │
                             ▼                     ▼
           ┌─────────────────────────────────────────────┐
           │ outlet_user_roles                           │
           │ PK user_id (FK)                             │
           │ PK role_id (FK)                             │
           └─────────────────────────────────────────────┘
```

```
┌─────────────────────┐
│ outlet_users        │
│ (actor, repeated)   │
└───────┬─────────┬───┘
        │         │
   1:*  │         │ 1:*
        ▼         ▼
┌─────────────────────┐   ┌─────────────────────┐
│ outlet_refresh_     │   │ outlet_audit_logs   │
│ sessions            │   │ PK id               │
│ PK id               │   │ FK actor_id (null)  │
│ FK user_id          │   │    action           │
│    family_id        │   │ ▸ entity_id         │
│ UK jti              │   │    metadata (jsonb) │
│    expires_at       │   │    occurred_at      │
│    revoked_at       │   └─────────────────────┘
│    rotated_at       │
└─────────────────────┘
```

### 2.3 Catalog cache and stock ledger

```
┌─────────────────────┐
│ catalog_items       │
│ PK menu_item_id  ▸  │
│    (HQ master item) │
│ ▸ assignment_id     │
│    sku              │
│    name             │
│    description      │
│    category         │
│    effective_price_ │
│       minor         │
│    currency_code    │
│    active           │
│    hq_item_version  │
│    applied_revision │
└──────┬──────────┬───┘
       │          │
  1:0..1        1:*
       │          │
       ▼          └──────────────┐
┌─────────────────────┐          │
│ inventory_balances  │          │
│ PK menu_item_id FK  │          │
│    quantity_on_hand │          │
│       CHECK >= 0    │          │
│    version          │          │
└─────────────────────┘          │
                                 ▼
                      ┌─────────────────────┐
                      │ stock_movements     │
                      │ PK id               │
                      │ FK menu_item_id     │
                      │    delta_quantity   │
                      │    reason (SALE |   │
                      │      RESTOCK |      │
                      │      WRITE_OFF |    │
                      │      RECOUNT)       │
                      │ FK source_sale_id   │
                      │    (DEFERRABLE,     │
                      │     → sales, 2.4)   │
                      │ FK actor_id (null)  │
                      │    request_id       │
                      │    occurred_at      │
                      └─────────────────────┘
```

### 2.4 Sales, receipts and idempotency

```
┌─────────────────────┐
│ outlet_users        │
│ (actor, repeated)   │
└─────────┬───────────┘
          │ 1:* (created_by)
          ▼
┌─────────────────────┐
│ sales               │
│ PK id               │
│ FK outlet_id        │
│ UK* receipt_number  │
│ UK* receipt_no      │
│    total_minor      │
│    currency_code    │
│    status           │
│    catalog_revision │
│    sold_at          │
│ FK created_by       │
└──────┬─────────┬────┘
       │         │
  1:*  │         │ 1:*
       ▼         └─────────────────┐
┌─────────────────────┐            │
│ sale_items          │            │
│ PK id               │            │
│ FK sale_id          │            │
│ FK menu_item_id     │            │
│    name_snapshot    │            │
│    sku_snapshot     │            │
│    quantity         │            │
│    unit_price_minor │            │
│    subtotal_minor   │            │
│    catalog_revision │            │
└─────────────────────┘            ▼
                        ┌─────────────────────┐
                        │ sale_idempotency_   │
                        │ keys                │
                        │ PK id               │
                        │ UK* key             │
                        │    request_sha256   │
                        │ FK sale_id          │
                        │    response_json    │
                        │    expires_at       │
                        └─────────────────────┘

UNIQUE (outlet_id, receipt_number) · UNIQUE (outlet_id, receipt_no)
UNIQUE (sale_id, menu_item_id)    · UNIQUE (outlet_id, key)
stock_movements.source_sale_id → sales (deferrable FK — canvas 2.3)
```

### 2.5 Transactional outbox and delivery attempts

```
┌─────────────────────┐
│ outbox_counters     │
│ PK outlet_id        │
│    next_sequence    │
└─────────────────────┘
         ┆ allocates next_sequence (logical, no FK)
         ┄┄┄►
┌─────────────────────┐
│ outbox_events       │
│ PK id (= eventId)   │
│ FK outlet_id        │
│ UK* sequence_no     │
│    event_type       │
│    schema_version   │
│    payload (jsonb)  │
│    payload_sha256   │
│    status (PENDING/ │
│      RETRY/DELIVERED│
│      /QUARANTINED)  │
│    attempts         │
│    next_attempt_at  │
│    lease_until      │
│    published_at     │
│    last_error       │
└──────────┬──────────┘
           │ 1:* (outbox_event_id, ON DELETE CASCADE)
           ▼
┌─────────────────────┐
│ sync_attempt_logs   │
│ PK id               │
│ FK outbox_event_id  │
│    status_code      │
│    duration_ms      │
│    error_code       │
│    attempt_at       │
└─────────────────────┘
```

---

## 3. Cross-database logical references (no FKs — PRD §6)

HQ and the outlet are independent databases; the pairs below are plain UUIDs
validated against the owning authority by application logic. Dashed = logical only.

```
┌───────────────────────────────┐           ┌───────────────────────────────┐
│ OUTLET DB (fnb_outlet_a)      │           │ HQ DB (fnb_hq)                │
│                               │           │                               │
│ catalog_items ┄ menu_item_id ─┼┄┄┄┄┄┄┄┄┄┄►│ master_menu_items             │
│ catalog_items ─ assignment_id─┼┄┄┄┄┄┄┄┄┄┄►│ outlet_menu_assignments       │
│ outlet_identity ── outlet_id ─┼┄┄┄┄┄┄┄┄┄┄►│ outlets                       │
│ outlet_identity ─ company_id──┼┄┄┄┄┄┄┄┄┄┄►│ companies                     │
│                               │           │                               │
│ sales                         ├◄┄┄┄┄┄┄┄┄┄┄┤ hq_sales                      │
│ sale_items                    ├◄┄┄┄┄┄┄┄┄┄┄┤ hq_sale_items                 │
│ outbox_events                 ├◄┄┄┄┄┄┄┄┄┄┄┤ sync_inbox_events             │
└───────────────────────────────┘           └───────────────────────────────┘
```

| Logical reference | Direction | Meaning |
|---|---|---|
| `catalog_items.menu_item_id` | outlet → HQ `master_menu_items.id` | Local catalog row mirrors one master item |
| `catalog_items.assignment_id` | outlet → HQ `outlet_menu_assignments.id` | Provenance of the assignment |
| `outlet_identity.outlet_id` | outlet ↔ HQ `outlets.id` | Identity issued by HQ at provisioning |
| `outlet_identity.company_id` | outlet → HQ `companies.id` | Tenant reference copied at provisioning |
| `hq_sales.source_sale_id` | HQ → outlet `sales.id` | Which local sale the projection came from |
| `hq_sale_items.source_sale_item_id` | HQ → outlet `sale_items.id` | Line provenance |
| `sync_inbox_events.event_id` | HQ → outlet `outbox_events.id` | Exactly-once dedupe key |

---

## 4. Invariants the schema enforces

- `sales`: UNIQUE `(outlet_id, receipt_number)` and `(outlet_id, receipt_no)` — gapless,
  outlet-scoped receipts allocated under a row lock on `receipt_counters`.
- `outbox_events` / `outbox_counters`: contiguous per-outlet `sequence_no`; HQ dedupes on
  `sync_inbox_events` UNIQUE `(outlet_id, event_id)` and `(outlet_id, sequence_no)`.
- `outlet_catalog_changes`: UNIQUE `(outlet_id, revision)` — one locked
  `outlet_catalog_revisions` row per outlet gates every menu distribution.
- `sale_items`: line-level CHECKs (`quantity > 0`, nonnegative money,
  `subtotal = quantity × unit_price` enforced in the sale transaction).
- `inventory_balances`: CHECK `quantity_on_hand >= 0` — insufficient stock rolls the
  whole sale back.
- `stock_movements.source_sale_id` is `DEFERRABLE INITIALLY DEFERRED` so the sale
  transaction may append movements before inserting the sale header; integrity is
  enforced at COMMIT.
- `hq_sale_items` keeps `name_snapshot` / `unit_price_minor` — HQ price changes never
  rewrite history (AT-19).
