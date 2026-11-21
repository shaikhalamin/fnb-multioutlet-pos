# outlet-frontend

Outlet point-of-sale UI for the multi-outlet F&B platform — React 19 SPA
(TanStack Start in SPA mode, Vite, Tailwind), served by its own Nginx which
reverse-proxies `/api/` to the outlet backend.

UI follows the editorial design system (off-white canvas, ink pill CTAs,
EB Garamond display + Inter body, self-hosted via Fontsource) — see
[../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md).

## Commands (pnpm via corepack)

```bash
corepack enable
pnpm install
pnpm generate:api     # regenerate src/api/generated from the contract
pnpm dev              # Vite dev server (proxies /api → OUTLET_API_PROXY_TARGET)
pnpm build            # tsc --noEmit && vite build (type-check gate first)
pnpm lint && pnpm check
```

## Phase 0 foundation

- **Envelope + error plumbing** — `X-Request-Id` per request,
  `ApiSuccess`/`ApiError` envelope unwrapping (PRD §7.1) and a stable
  `ApiError` type.
- **Query layer** — `src/lib/query-client.ts` shared QueryClient factory;
  no optimistic UI for financial data (PRD §11).
- **Shell** — landing page with a live terminal-health panel (local
  database/queue status) refreshed every 30s.

## Phase 2 — POS operations

- **Generated clients only** (AGENTS §4.1) — Kubb generates the typed Axios
  client + Zod schemas + TanStack Query helpers from
  `src/api/contracts/outlet.openapi.json` (copied from
  `outlet-backend/openapi/openapi.json` after `pnpm openapi:export`).
  `src/api/axios.ts` configures the generated runtime's single instance:
  bearer token from the in-memory session store, single-flight refresh via
  the `outlet_rt` HttpOnly cookie, envelope unwrap, request IDs. Money
  payloads are parsed with the generated Zod schemas in the `queryFn`.
- **Login + protected shell** — `/login` (Zod-validated form,
  `error.code`-driven messages), silent-refresh bootstrap, `_auth` layout
  with permission-gated navigation and logout.
- **POS** (`features/pos`) — menu grid (`formatMinor` string money, live
  stock), quantity-stepper cart, checkout with **one idempotency key per
  sale attempt** held in a ref across retries until response or
  abandonment (AGENTS §4.4), totals rendered exclusively from the
  authoritative `SaleResponse`, receipt confirmation panel with print.
- **Inventory** (`features/inventory`) — balances table + audited
  adjustment dialog (RESTOCK/WRITE_OFF/RECOUNT, signed quantity, Zod
  validation, `INSUFFICIENT_STOCK` surfacing).
- **Sales history** (`features/sales`) — Zod-validated `from/to` search
  params, keyset pagination via envelope `meta.nextCursor`, receipt detail
  with immutable snapshots and reprint.
- **Sync banner** (`features/sync-status`) — 30s poll of
  `GET /sync/status`: menu revision, last sync, pending uploads, escalating
  grace-expiry warning. Purely informational — a local sale is never
  blocked by the banner.
- **Users** (`features/users`) — manager-only local staff management
  (list/create/edit) over the Phase-2 backend endpoints.

Machine sync credentials live only in the outlet worker — never in this
app. Frontend permission gating is UX only; the backend re-validates
everything (AGENTS §4.2).
