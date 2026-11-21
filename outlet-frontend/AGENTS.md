# AGENTS.md — outlet-frontend

Independent Outlet POS React application (React 19, Vite, TanStack Router/Query, Tailwind v4, shadcn-style `components/ui`).
Read the root [../AGENTS.md](../AGENTS.md) first — universal frontend API and design-system rules apply (§4.5). Design system: [../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md). Source of truth: [../fnb_multi_outlet_prd.md](../fnb_multi_outlet_prd.md) ("PRD").

## Mission

Outlet POS: local login, responsive menu/cart with live stock, checkout, receipt detail/reprint, audited inventory adjustments, local sales history, and sync-status visibility (last menu sync / pending uploads banner) (PRD §11).

## Design system

Styling follows the editorial design system in [../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) — `src/styles.css` is the single token/class source (Tailwind v4 CSS-first; no `tailwind.config.*`). In short: token utilities only (no hardcoded hex/rgba), ink pill `.btn-primary` is the only primary CTA, `font-display` (EB Garamond) is never bolded, orbs are `aria-hidden` decoration only, money uses `.money` (Inter tabular numerals, never `font-mono`), no dark mode, fonts self-hosted via Fontsource. `src/styles.css` stays **byte-identical** to `hq-frontend/src/styles.css` — copy changes across in the same commit. Preserve `print:*` variants when restyling receipt views.

## Commands

```bash
pnpm dev            # Vite dev server (port 3000)
pnpm build          # type-check + build (also regenerates TanStack route tree)
pnpm lint           # ESLint
pnpm format         # Prettier + ESLint --fix
pnpm check          # Prettier --check
```

## Strict rules

### API calling strategy (PRD §11) — never bypass

1. All server calls go through **Kubb-generated** typed Axios clients + Zod schemas + TanStack Query hooks, generated from `outlet-backend`'s exported `openapi/openapi.json` (contract copied to `src/api/contracts/outlet.openapi.json`; output in `src/api/generated/`). Never hand-write `fetch`/`axios` calls or duplicate API types.
2. The generated client must reuse the shared axios instance/interceptors in `src/api/axios.ts` (envelope unwrap, `X-Request-Id`, auth header, refresh-on-401, `ApiError` normalization). No other axios instances; never hand-edit `src/api/generated/`.
3. This app talks **only** to its own local outlet backend. It never calls HQ and never sees the outlet machine key (PRD §2, §9.2).

### Financial-action discipline (PRD §7.3, §11, §15) — the critical rules

4. A checkout attempt mints **one** `Idempotency-Key` and reuses it for every retry of that attempt (including after timeouts/navigation back to a pending cart). Mint a new key only for a genuinely new sale. A second key for the same attempted sale is a defect (AT-07/AT-08).
5. The sale payload contains **only** `items: [{ menuItemId, quantity }]`. Never send price, total, receipt number, outlet ID, or client timestamps — the backend computes them all.
6. **No optimistic stock or money updates.** Cart quantity edits are local; stock and totals confirm only from the authoritative `SaleResponse` (PRD §11). Optimistic UI is restricted to non-financial actions.
7. Money is a decimal-minor-unit **string** end-to-end; format only at render. Quantities are positive integers.

### State, routing, validation

8. Server state only via TanStack Query with feature key factories (`src/features/pos`, `inventory`, `sales`, `receipts`, `sync-status`). Writes are mutations invalidating their keys; refetch the menu after sync events rather than mutating cached prices client-side.
9. TanStack Router with protected layouts; Zod validates all forms and search params (`validateSearch`). Keyboard-accessible POS flows and visible, readable errors are requirements (PRD §16).
10. On network failure to the **local** backend, retry with the same idempotency key and surface a clear offline state — the outlet backend remains authoritative even when HQ is unreachable (PRD §8.8).
11. Always surface the sync banner (last menu sync time, pending upload count) from `GET /sync/status` so cashiers know catalog freshness; never block a valid local sale on HQ reachability (PRD FR-10, §11).
12. Access token in memory only; refresh stays in the backend's HttpOnly cookie. Never `localStorage`.
