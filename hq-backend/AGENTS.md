# AGENTS.md — hq-backend

Independent HQ NestJS application (API entrypoint `src/main.ts` + worker entrypoint `src/worker-main.ts`).
Read the root [../AGENTS.md](../AGENTS.md) first — all universal wire-format, DTO/Swagger, and error rules apply here.
Source of truth: [../fnb_multi_outlet_prd.md](../fnb_multi_outlet_prd.md) ("PRD").

## Mission

HQ owns master menu governance, outlet assignment and price overrides, outlet API keys, sync ingestion (inbox), and cross-outlet reporting (read projections). HQ **never** initiates connections to outlets and **never** reads/writes an outlet database (PRD §1, §2).

## Commands

```bash
pnpm build            # nest build
pnpm start:dev        # API in watch mode
pnpm start:worker     # worker entrypoint (dist/worker-main.js)
pnpm lint             # oxlint (type-aware)
pnpm test             # Vitest unit/integration
pnpm test:e2e         # Vitest e2e
pnpm migration:run    # TypeORM migrations (single controlled job — never per API replica)
pnpm openapi:export   # rebuild openapi/openapi.json → consumed by hq-frontend Kubb
```

## Module map (build in this order; PRD §5, §18)

`auth`, `users`, `outlets`, `menu`, `assignments`, `api-keys`, `sync-ingest`, `reporting`, `audit` — each under `src/modules/<name>/` with controller + service + repository + `dto/`. Queues under `src/queues/` (`catalog-fanout`, `audit-cleanup`). Entities in `src/database/entities/` matching PRD §6.1 tables exactly.

## Strict rules

### Endpoints and DTOs (PRD §7.2, §7.4)

1. Human routes exactly as listed in PRD §7.2 (`/auth/*`, `/menu-items`, `/outlets`, `/outlets/:outletId/menu/:itemId`, `/outlets/:outletId/api-keys*`, `/reports/*`, `/outlets/:id/sync-status`). Machine sync routes exactly as in §7.4 under `/sync/v1/*`.
2. DTO names from PRD §7.1: `AssignMenuRequest`, `OutletMenuResponse`, `CatalogChangesResponse`, `EventBatchRequest`, `EventBatchResponse`, etc. Every property carries explicit `@ApiProperty` (no CLI plugin). Money/revision fields are decimal strings with examples (`"1000"`, `"42"`).
3. Human routes: `@ApiSecurity('bearer-jwt')` + permission decorator (`menu.write`, `assignments.write`, `keys.manage`, `reports.read`, `sync.read`, `outlets.write`). Sync routes: `@ApiSecurity('outlet-key')` + key-scope guard (`menu.pull`, `events.push`, `status.write`).
4. Sync routes never allow CORS browser access and never appear in the frontend OpenAPI consumption path beyond documentation (PRD §7.4, §9.2).
5. Controllers stay thin; the global envelope interceptor wraps, the global filter renders `ApiError`. Never touch `res.json`.

### Business invariants (PRD FR-01, FR-02, §6.1, §8.2)

6. Menu edits commit atomically with per-outlet revision generation and change-log writes: lock `outlet_catalog_revisions`, increment, append `outlet_catalog_changes` — all in the admin mutation's transaction. Never commit a menu change without its durable distribution record (§8.2 rule 5).
7. Archive/tombstone instead of hard-delete for items and assignments. Effective price = override ?? master default, nonnegative bigint minor units, single currency per item/outlet.
8. `(outlet_id, menu_item_id)` has at most one effective assignment; never hard-delete assignment history.

### Sync ingest (PRD FR-07, §8.5, §8.6)

9. Derive `outletId` **only** from the authenticated key record. A submitted event whose `outletId` differs rejects the entire request (§7.4).
10. Per event, in **one HQ PostgreSQL transaction**: validate schema/version + totals → insert `sync_inbox_events` (unique `(outletId,eventId)` + `(outletId,sequenceNo)`, immutable `payload_sha256`) → write projections (`hq_sales`, `hq_sale_items`) → update contiguous sequence checkpoint → ack.
11. Batch acks: `ACCEPTED`, `DUPLICATE` (same canonical hash → terminal success), `RETRYABLE_ERROR`, `REJECTED_PERMANENT` (different payload under a reused identity → quarantine + security audit; never overwrite the original). HTTP 200 may mix event statuses.
12. Never recompute stored sale lines from today's catalog; projections store what the event carried (§8.1).

### Keys and auth (PRD §9)

13. API keys: 256-bit random secret shown once, stored as hash + pepper, constant-time compare, scoped, rotatable with bounded overlap. Never log or return a raw secret after issuance.
14. Refresh tokens: opaque, rotated per refresh, hash-only storage, reuse revokes the family, rotation serialized/CAS. `POST /auth/refresh` sets the cookie; the login response JSON never contains the refresh token.

### Reporting (PRD FR-08, §10)

15. Reports query **HQ projections only**, count `COMPLETED` accepted sales, and always include `dataAsOf` + per-outlet `lastIngestedAt`/watermark. `isProvisional` when any outlet is behind. Top items: max 5 in V1, deterministic tie-break by `menu_item_id`.

### Environment

16. Config only via `ConfigService<Env, true>` + `config.get('KEY', { infer: true })`. `APP_ENTRYPOINT=api|worker` selects the validation profile (worker never holds JWT signing secrets). Real env > `.env.local` > `.env` (PRD §14.1).
