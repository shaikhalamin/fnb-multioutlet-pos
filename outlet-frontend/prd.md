# PRD — Outlet Frontend (`outlet-frontend`)

**Parent PRD:** [`../fnb_multi_outlet_prd.md`](../fnb_multi_outlet_prd.md) (Multi-Outlet F&B Management Platform, V1.0)
**Scope:** V1.0 core responsibilities only — optional items are excluded.
**Technology:** React, TypeScript, Vite, TanStack Router/Query, Zod, Kubb, Axios, Nginx, Docker

---

## 1. Overview and boundaries

`outlet-frontend` is the independent Outlet React application — the POS used on-site by Outlet Managers, Cashiers, and Inventory Clerks. It talks **only** to the local outlet backend (`outlet-backend`) at `VITE_API_BASE_URL` using short-lived JWT access tokens with rotating refresh tokens in `HttpOnly` cookies. It is deployed per outlet site alongside that outlet's API, worker, DB, and Redis.

**Boundary rules that govern this app:**

- **No machine secrets ever.** The HQ outlet key, JWT signing keys, and server secrets must never appear in this bundle, generated clients, or logs. Sync is the backend worker's job — the UI only _displays_ sync status.
- **Never submit authoritative financial data.** The POS sends only `{menuItemId, quantity}` lines plus a stable `Idempotency-Key`; prices, totals, receipt numbers, outlet ID, and timestamps are computed by the outlet backend. The UI renders the backend's response as truth.
- No frontend route hiding is considered sufficient authorization — backend guards decide; the UI only reflects permissions.
- Works against the **local** backend even when the site is cut off from HQ (offline sales policy is enforced backend-side; the UI surfaces the state).

## 2. Users and permissions

| Role            | What they do in this UI                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Outlet Manager  | View assigned menu, make sales, adjust stock, manage authorized local users, view local reports. |
| Cashier         | Read active menu, create sales, view/reprint local receipts.                                     |
| Inventory Clerk | View stock and create audited stock adjustments; no menu master edits.                           |

Client-side permission gating (`lib/permissions.ts`) mirrors backend permissions (`menu.read`, `sales.create`, `sales.read`, `inventory.read`, `inventory.adjust`, `sync.read`) purely for UX; every action is still authorized server-side. The cashier's outlet scope comes from the login response identity, never from client input.

## 3. Product scope (screens and features)

1. **Local login** — email/password against the local outlet backend; transparent access-token refresh (cookie-based rotation); logout revokes the session.
2. **Responsive POS menu/cart** — active, locally assigned items only with effective prices; add/remove lines, adjust positive quantities before checkout.
3. **Live stock availability** — show `availableQuantity` per item from `/menu`; disable/guard over-quantity lines client-side while still handling backend `409 INSUFFICIENT_STOCK` authoritatively.
4. **Checkout with stable idempotency** — mint **one** `Idempotency-Key` per attempted sale (e.g. `pos-register-2-<uuid>`) and reuse it across all retries; never mint a second key for the same attempted sale. On network failure between browser and _local backend_, retry with the same key. Render the confirmed sale (totals, lines, `receiptNo`, `soldAt`, `syncStatus`) from the backend response only.
5. **Receipt detail / reprint** — view a sale's immutable lines and historical prices; reprint the receipt.
6. **Inventory adjustment** — restock/write-off with a required audit reason; records actor and request ID server-side.
7. **Local sales history** — cursor-pagized `GET /sales?from=&to=&cursor=` with date filters.
8. **Sync-status banner** — last menu sync (`lastCatalogSyncAt`, `catalogRevision`) and pending-upload/queued state from `/sync/status`; clearly flag when the site is operating on the last synchronized catalog (offline grace is a backend policy — the UI surfaces, never decides, it).

Use TanStack Router and TanStack Query, with **optimistic UI only for non-financial actions**. Stock levels and sale confirmation must use the authoritative backend response, never a local optimistic decrement. The outlet ID of the signed-in user is displayed from server identity, never editable.

## 4. API consumption

Consumes the outlet backend REST API (`https://outlet-a.example.local/api/v1`) — human JWT endpoints: `/auth/*`, `/menu`, `/inventory`, `/inventory/adjustments`, `/sales`, `/sales/:id`, `/sync/status`. Full endpoint contract: see [`../outlet-backend/prd.md`](../outlet-backend/prd.md) §4.

**Contract rules:**

- Envelope shapes `ApiSuccess<T>` / `ApiError` with `requestId`; money is a decimal string (`MoneyMinor`, regex `^(0|[1-9][0-9]*)$`) — never parse money into JS floats; `quantity` is an integer.
- Generate typed Axios API functions, TypeScript DTOs, Zod validation schemas, and TanStack Query helpers from the outlet OpenAPI contract via Kubb into `src/api/generated/`; do not manually maintain conflicting API types.
- Parse high-risk API responses (money, IDs, timestamps) with Zod before use.
- Map `error.code` to clear user-facing messages: `INSUFFICIENT_STOCK` (show requested vs available per item), `ITEM_INACTIVE`/`ITEM_NOT_ASSIGNED` (remove from cart, refresh menu), `IDEMPOTENCY_KEY_REUSED` (surface conflict — do not auto-mint a new key), `VALIDATION_FAILED`, `UNAUTHENTICATED`, `RATE_LIMITED`. Handle 401 with a single transparent refresh-and-retry before redirecting to login.

## 5. Kubb generation pipeline

Export the outlet OpenAPI document from the outlet NestJS backend in CI; verify schema diff against backward-compatibility rules; generate the client under `src/api/generated/` using Kubb TS + Axios + Zod + React Query plugins. Commit generated artifacts consistently or generate deterministically in CI; block merges when generation is stale. Pin the exact Kubb plugin configuration to a tested compatible version in `pnpm-lock.yaml`. The OpenAPI source artifact lives at `src/api/contracts/outlet.openapi.json`.

## 6. Validation and error handling

| Layer                | Rules                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Cart/checkout forms  | Zod schemas: positive integer quantities, max items per sale, no unknown fields.                  |
| Search/filter params | Zod-validated via TanStack Router.                                                                |
| API responses        | Parse high-risk responses (money, IDs, timestamps) with generated Zod schemas.                    |
| Financial actions    | No optimistic stock decrement or optimistic sale confirmation; backend response is authoritative. |
| Global errors        | Standard error codes mapped to actionable inline messages with `requestId` for support.           |

## 7. Configuration and deployment

- Environment: `VITE_API_BASE_URL` (build-time public config), frontend app version. No machine secrets in the bundle — anything secret must not be embedded in Vite build layers.
- CORS: the outlet backend allows only this app's origin.
- Multi-stage `Dockerfile`: Vite build + its own Nginx (`nginx/nginx.conf`) serving static assets; non-root, health checks; no environment secrets in build layers or the Vite bundle.
- Compose service: `outlet-a-web` (static web) alongside `outlet-a-db`, `outlet-a-redis`, `outlet-a-api`, `outlet-a-worker`; deployed **once per outlet site**.

## 8. Nonfunctional targets

- **Accessibility:** keyboard-accessible POS workflows (scan → quantity → checkout without a mouse), visible errors, readable contrast.
- POS interactions must feel immediate on site hardware while never fabricating financial state.
- Checkout latency tolerance: the UI keeps the idempotency key stable across slow networks and app reloads within the retry horizon.

## 9. Acceptance scenarios (outlet-frontend-relevant subset)

| ID    | Scenario                                  | Expected result                                                                                  |
| ----- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AT-03 | Cashier sells 2 burgers + 1 pizza         | Cart sends only item IDs + quantities; confirmed totals/receipt rendered from backend response.  |
| AT-04 | A cart line exceeds stock                 | Backend 409 `INSUFFICIENT_STOCK` shown per item; cart remains editable; no partial confirmation. |
| AT-07 | Network hiccup; retry same sale           | Same `Idempotency-Key` reused; same sale/receipt shown; no duplicate charge.                     |
| AT-08 | Retry with edited cart under the same key | Backend 409 `IDEMPOTENCY_KEY_REUSED`; UI explains and starts a new key for the new attempt.      |
| AT-11 | Site offline 24 hours                     | POS keeps working against the local backend; sync banner shows stale catalog/pending uploads.    |
| AT-12 | HQ removed an item mid-shift              | Menu refresh reflects it once REMOVE applied; new sale attempts show a clear denial.             |
| AT-19 | HQ changed a price after a synced sale    | Historical receipt still shows the original unit price.                                          |

End-to-end browser tests cover login, POS cart → checkout → receipt flow (including idempotent retry), inventory adjustment with audit reason, sales history, and the sync-status banner.

## 10. Folder structure

```text
outlet-frontend/                     # Independent Outlet React application
│
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   │
│   ├── routes/                      # TanStack Router, protected route layouts
│   │
│   ├── features/
│   │   ├── auth/
│   │   ├── pos/
│   │   ├── inventory/
│   │   ├── sales/
│   │   ├── receipts/
│   │   └── sync-status/
│   │
│   ├── components/
│   │   ├── ui/
│   │   └── layout/
│   │
│   ├── api/
│   │   ├── axios.ts
│   │   ├── contracts/
│   │   │   └── outlet.openapi.json
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
├── nginx/                           # Outlet frontend's own Nginx
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

## 11. Roadmap phases (outlet-frontend scope)

- **Phase 0 – Foundation:** app shell, strict TS, lint/format, env validation, CI, Dockerfile, compose (`outlet-a-web`), Kubb pipeline scaffold.
- **Phase 2 – Outlet operations UI:** local login, POS menu/cart with live stock, idempotent checkout, receipt detail/reprint, inventory adjustment, local sales history.
- **Phase 3 – Sync visibility:** sync-status banner (menu revision, last sync, pending uploads) from `/sync/status`.
- **Phase 4 – Hardening:** accessibility pass, error-state polish, end-to-end browser tests including retry/offline scenarios.

**Definition of done (this app):** relevant AT scenarios pass; generated Kubb clients current with the outlet OpenAPI contract; no secrets in bundle or logs; a retried sale never double-charges or mints a second idempotency key; POS workflows are keyboard accessible.
