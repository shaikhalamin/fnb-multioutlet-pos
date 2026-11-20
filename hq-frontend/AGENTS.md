# AGENTS.md — hq-frontend

Independent HQ React application (React 19, Vite, TanStack Router/Query, Tailwind, shadcn-style `components/ui`).
Read the root [../AGENTS.md](../AGENTS.md) first — universal frontend API rules apply. Source of truth: [../fnb_multi_outlet_prd.md](../fnb_multi_outlet_prd.md) ("PRD").

## Mission

HQ admin console: login/MFA, dashboard (revenue, lag, outlet health), master categories/menu CRUD, assignment matrix with override editor + effective-price preview, outlet & API-key lifecycle (secret shown once), reports with date filters and `dataAsOf`, sync-health panel, audit views (PRD §11).

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

1. All server calls go through **Kubb-generated** typed Axios clients + Zod schemas + TanStack Query hooks, generated from `hq-backend`'s exported `openapi/openapi.json` (contract copied to `src/api/contracts/hq.openapi.json`; output in `src/api/generated/`). Never hand-write `fetch`/`axios` calls or duplicate API types — the OpenAPI contract is the only API type source.
2. The generated client must reuse the shared axios instance/interceptors in `src/api/axios.ts` (envelope unwrap, `X-Request-Id`, auth header, refresh-on-401, `ApiError` normalization). Do not create other axios instances; do not hand-edit `src/api/generated/`.
3. Never call outlet backends or HQ `/sync/v1/*` machine endpoints from this browser app (PRD §7.4). Machine sync is outlet-worker-only; the API-key secret is displayed once at issuance and never logged/stored client-side beyond that view.

### State, routing, validation

4. Server state only via TanStack Query with feature-scoped key factories in `src/features/<feature>/` (e.g. `menuKeys`, `outletKeys`). Writes are mutations that invalidate their keys. No `useEffect` fetching.
5. TanStack Router with protected route layouts (auth + permission gating via `src/lib/permissions.ts`); every route validates search/query params with Zod (`validateSearch`). Route/UI hiding is cosmetic — the backend enforces authorization (PRD §9.3).
6. Zod for all forms and for parsing high-risk responses. Show inline, actionable messages from `ApiError.code`.
7. Money is a decimal-minor-unit **string** end-to-end; format only at render via a shared formatter. Date/time filters submit UTC ISO 8601 (`from` inclusive, `to` exclusive).

### UX invariants from the PRD

8. Report views must always render `dataAsOf` and per-outlet sync watermarks / `isProvisional` — stale data must never read as "zero sales" (PRD §8, AT-20).
9. The override editor previews `effectivePriceMinor` (override ?? default) before saving (PRD FR-02).
10. Access token in memory only; refresh stays in the backend's HttpOnly cookie. Never `localStorage`.
