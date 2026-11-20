# PRD — HQ Frontend (`hq-frontend`)

**Parent PRD:** [`../fnb_multi_outlet_prd.md`](../fnb_multi_outlet_prd.md) (Multi-Outlet F&B Management Platform, V1.0)
**Scope:** V1.0 core responsibilities only — optional items (e.g. optional report permissions for Menu Managers) are excluded.
**Technology:** React, TypeScript, Vite, TanStack Router/Query, Zod, Kubb, Axios, Nginx, Docker

---

## 1. Overview and boundaries

`hq-frontend` is the independent HQ React application used by HQ staff (Super Admin, Menu Manager, Analyst). It talks **only** to the HQ backend (`hq-backend`) at `VITE_API_BASE_URL` using short-lived JWT access tokens with rotating refresh tokens in `HttpOnly` cookies.

**Boundary rules that govern this app:**

- **No machine secrets ever.** Build-time public config only (`VITE_API_BASE_URL`, app version). Outlet API keys, JWT signing keys, and server secrets must never appear in the bundle, generated clients, or logs. Key-issuance is done via admin endpoints; the raw secret is shown **once** in the UI and never persisted or logged by the client.
- No frontend route hiding is considered sufficient authorization — the backend enforces guards; the UI only reflects permissions for usability.
- The HQ UI never accesses outlet systems, outlet sync endpoints, or outlet databases.
- No shared session cookies across HQ/outlet domains.

## 2. Users and permissions

| Role            | What they do in this UI                                                  |
| --------------- | ------------------------------------------------------------------------ |
| HQ Super Admin  | Manage outlets, users, roles, API keys, all menus, assignments, reports. |
| HQ Menu Manager | Manage categories/items, outlet assignment and price overrides.          |
| HQ Analyst      | Read cross-outlet reports and sync status; cannot modify operations.     |

Client-side permission gating (`lib/permissions.ts`) mirrors backend permissions (`menu.read`, `menu.write`, `outlets.read`, `outlets.write`, `assignments.write`, `keys.manage`, `reports.read`, `sync.read`) purely for UX; every action is still authorized server-side.

## 3. Product scope (screens and features)

1. **Login** — email/password sign-in. Handles access-token refresh transparently (cookie-based rotation); logout revokes the session.
2. **Dashboard** — revenue overview, replication lag, outlet health.
3. **Master menu management** — categories and menu item CRUD (create/update/archive/list), including SKU, description, category, default price, currency, status. Archived items shown via status, never hard-deleted.
4. **Assignment matrix by outlet** — assign/unassign items per outlet; effective-price preview (override or master default) before saving.
5. **Override editor** — set per-outlet `priceOverrideMinor`; live preview of `effectivePriceMinor`.
6. **Outlet & key lifecycle administration** — provision outlets, issue API keys (reveal secret **one time**), rotate with bounded overlap, revoke, audit key usage.
7. **Reports** — revenue by outlet and top-5 items per outlet with date filters (`from` inclusive / `to` exclusive, UTC); always surface `dataAsOf`, `lastIngestedAt`, and provisional/stale indicators so users never confuse unsynced outlet sales with zero sales.
8. **Sync-health panel** — per-outlet menu revision, last ingested event, failure counts, checkpoint/backlog status as reported by HQ.
9. **Audit views** — operations/security audit log entries.

Use TanStack Router protected route layouts and Zod-validated query/search params for all list/filter views.

## 4. API consumption

Consumes the HQ backend REST API (`https://hq.example.com/api/v1`) — human JWT endpoints: `/auth/*`, `/menu-items`, `/outlets`, `/outlets/:outletId/menu/:itemId`, `/outlets/:outletId/api-keys*`, `/reports/revenue-by-outlet`, `/reports/outlets/:id/top-items`, `/outlets/:id/sync-status`. Full endpoint contract: see [`../hq-backend/prd.md`](../hq-backend/prd.md) §4.

**Contract rules:**

- Envelope shapes `ApiSuccess<T>` / `ApiError` with `requestId`; money is a decimal string (`MoneyMinor`, regex `^(0|[1-9][0-9]*)$`) — never parse money into JS floats.
- Generate typed Axios API functions, TypeScript DTOs, Zod validation schemas, and TanStack Query helpers from the HQ OpenAPI contract via Kubb into `src/api/generated/`; do not manually maintain conflicting API types.
- Parse high-risk API responses with Zod before use; surface `error.code` + `message` from `ApiError` with meaningful inline messages.
- Handle 401 with a single transparent refresh-and-retry before redirecting to login; show 403/404/409/422/429/503 states distinctly.

## 5. Kubb generation pipeline

Export the HQ OpenAPI document from NestJS in CI; verify schema diff against backward-compatibility rules; generate the client under `src/api/generated/` using Kubb TS + Axios + Zod + React Query plugins. Commit generated artifacts consistently or generate deterministically in CI; block merges when generation is stale. Pin the exact Kubb plugin configuration to a tested compatible version in `pnpm-lock.yaml`. The OpenAPI source artifact lives at `src/api/contracts/hq.openapi.json`.

## 6. Validation and error handling

| Layer                | Rules                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forms                | Zod schemas for all forms with meaningful inline error messages.                                                                                                 |
| Search/filter params | Zod-validated via TanStack Router; invalid params rejected, not silently coerced.                                                                                |
| API responses        | Parse high-risk responses (money, IDs, timestamps) with generated Zod schemas.                                                                                   |
| Global errors        | Standard error codes (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, …) mapped to clear user-facing messages with `requestId` for support. |

## 7. Configuration and deployment

- Environment: `VITE_API_BASE_URL` (build-time public config), frontend app version. No machine secrets in the bundle — anything secret must not be embedded in Vite build layers.
- CORS: the HQ backend allows only this app's origin.
- Multi-stage `Dockerfile`: Vite build + its own Nginx (`nginx/nginx.conf`) serving static assets; non-root, health checks; no environment secrets in build layers or the Vite bundle.
- Compose service: `hq-web` (static web) alongside `hq-db`, `hq-redis`, `hq-api`, `hq-worker`.

## 8. Nonfunctional targets

- Accessibility: visible errors, readable contrast; keyboard-navigable admin workflows.
- Reports must always disclose data freshness (`dataAsOf`) — never present a misleading real-time guarantee.
- Structured, observable failures: network/API errors are actionable, never silent.

## 9. Acceptance scenarios (HQ-frontend-relevant subset)

| ID    | Scenario                                        | Expected result                                                        |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| AT-01 | HQ assigns item only to A and B via UI          | A/B eventually receive item; C never appears/sells it.                 |
| AT-02 | Override editor sets B price $12 vs default $10 | Effective-price preview shows $12; existing sale snapshots unchanged.  |
| AT-17 | Cashier token used on HQ admin UI routes        | Denied by backend; UI routes to an error/no-access state.              |
| AT-18 | Old session after refresh rotation              | User re-authenticated cleanly; revoked family forces re-login.         |
| AT-20 | Reports viewed during outlet backlog            | UI discloses stale ingestion timestamp/watermark and provisional flag. |

End-to-end browser tests cover login, menu CRUD, assignment/override flow, key issuance (one-time reveal), and report freshness display.

## 10. Folder structure

```text
hq-frontend/                         # Independent HQ React application
│
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   │
│   ├── routes/                      # TanStack Router, protected route layouts
│   │
│   ├── features/
│   │   ├── auth/
│   │   ├── menu/
│   │   ├── assignments/
│   │   ├── outlets/
│   │   ├── reports/
│   │   └── sync/
│   │
│   ├── components/
│   │   ├── ui/
│   │   └── layout/
│   │
│   ├── api/
│   │   ├── axios.ts
│   │   ├── contracts/
│   │   │   └── hq.openapi.json
│   │   └── generated/               # Kubb output (TS + Axios + Zod + React Query)
│   │
│   ├── lib/
│   │   ├── query-client.ts
│   │   ├── permissions.ts
│   │   └── utils.ts
│   │
│   ├── schemas/
│   ├── hooks/
│   ├── types/
│   └── assets/
│
├── public/
│
├── nginx/                           # HQ frontend's own Nginx
│   └── nginx.conf
│
├── Dockerfile                       # React build + Nginx runtime
├── .dockerignore
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── kubb.config.ts
└── index.html
```

## 11. Roadmap phases (hq-frontend scope)

- **Phase 0 – Foundation:** app shell, strict TS, lint/format, env validation, CI, Dockerfile, compose (`hq-web`), Kubb pipeline scaffold.
- **Phase 1 – Security / HQ catalog UI:** login, protected routes, master menu CRUD, assignment matrix, override editor with effective-price preview, outlet/key lifecycle admin (one-time secret reveal).
- **Phase 3 – Sync visibility:** sync-health panel fed by `/outlets/:id/sync-status`.
- **Phase 4 – Reporting UI:** revenue/top-items reports with date filters, `dataAsOf`/staleness indicators, audit views, dashboard hardening.

**Definition of done (this app):** relevant AT scenarios pass; generated Kubb clients current with the HQ OpenAPI contract; no secrets in bundle or logs; accessible, keyboard-navigable flows; reports always disclose freshness.
