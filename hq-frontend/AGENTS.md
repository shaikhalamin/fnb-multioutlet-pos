# AGENTS.md — hq-frontend

Independent HQ React application (React 19, Vite, TanStack Router/Query, Tailwind v4, shadcn-style `components/ui`).
Read the root [../AGENTS.md](../AGENTS.md) first — universal frontend API and design-system rules apply (§4.5). Design system: [../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md). Source of truth: [../fnb_multi_outlet_prd.md](../fnb_multi_outlet_prd.md) ("PRD").

## Mission

HQ admin console: login, dashboard (revenue, lag, outlet health), master categories/menu CRUD, assignment matrix with override editor + effective-price preview, outlet & API-key lifecycle (secret shown once), reports with date filters and `dataAsOf`, sync-health panel, audit views (PRD §11).

## Design system

Styling follows the editorial design system in [../DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) — `src/styles.css` is the single token/class source (Tailwind v4 CSS-first; no `tailwind.config.*`). In short: token utilities only (no hardcoded hex/rgba), ink pill `.btn-primary` is the only primary CTA, `font-display` (EB Garamond) is never bolded, orbs are `aria-hidden` decoration only, money uses `.money` (Inter tabular numerals, never `font-mono`), no dark mode, fonts self-hosted via Fontsource. `src/styles.css` stays **byte-identical** to `outlet-frontend/src/styles.css` — copy changes across in the same commit.

## Commands

```bash
pnpm dev            # Vite dev server (port 3000)
pnpm typecheck      # tsc --noEmit (must be clean — part of build)
pnpm build          # tsc --noEmit + vite build (also regenerates TanStack route tree)
pnpm lint           # ESLint (also enforces no-unused-vars — see rule 12)
pnpm format         # Prettier + ESLint --fix
pnpm check          # Prettier --check
```

## Strict rules

### API calling strategy (PRD §11) — never bypass

1. All server calls go through **Kubb-generated** typed Axios clients + Zod schemas + TanStack Query hooks, generated from `hq-backend`'s exported `openapi/openapi.json` (contract copied to `src/api/contracts/hq.openapi.json`; output in `src/api/generated/`). Never hand-write `fetch`/`axios` calls or duplicate API types — the OpenAPI contract is the only API type source.
2. The generated client must reuse the shared axios instance/interceptors in `src/api/axios.ts` (envelope unwrap, `X-Request-Id`, auth header, refresh-on-401, `ApiError` normalization). Do not create other axios instances; do not hand-edit `src/api/generated/`.
3. Never call outlet backends or HQ `/sync/v1/*` machine endpoints from this browser app (PRD §7.4). Machine sync is outlet-worker-only; the API-key secret is displayed once at issuance and never logged/stored client-side beyond that view.
4. `src/api/contracts/hq.openapi.json` stays **byte-identical to the backend export** (copy it, never reformat it — it is in `.prettierignore`); after any contract change run `pnpm generate:api` and commit the regenerated output together with the contract.
5. Unassignment uses the generated `assignmentsControllerUnassign` (DELETE) client — `PUT active:false` is not a substitute; the DELETE is what records the REMOVE catalog revision server-side.

### State, routing, validation

6. Server state only via TanStack Query with feature-scoped key factories living in `src/features/<feature>/keys.ts` (e.g. `features/menu/keys.ts` exports `menuKeys`) — never declared inside route files. Writes are mutations that invalidate their keys. No `useEffect` fetching.
7. TanStack Router with protected route layouts (auth + permission gating via `src/lib/permissions.ts`); every route validates search/query params with Zod (`validateSearch`). Route/UI hiding is cosmetic — the backend enforces authorization (PRD §9.3).
8. Zod for all forms and for parsing high-risk responses: money-bearing reads parse in the `queryFn` with the generated `<op>Status200Schema` before render; the auth session user is parsed via `src/schemas/auth.ts` (`parseSessionUser`), which also narrows permissions to `HqPermission[]`. Show inline, actionable messages mapped from `ApiError.code` (see `routes/login.tsx`).
9. Money is a decimal-minor-unit **string** end-to-end; format only at render via `formatMinor` in `lib/utils`, which must stay pure string/integer math — never `Number(minor)/100` (float). Date/time filters submit UTC ISO 8601 (`from` inclusive, `to` exclusive).

### Types and gates

10. `SessionUser` is defined exactly once, in `src/lib/permissions.ts` (`permissions: HqPermission[]`, never `string[]`); `features/auth/session.ts` re-exports it. Adding a parallel user type reintroduces the TS2345 breakage fixed in Phase 1.
11. `pnpm build` type-checks (`tsc --noEmit` first). Never "fix" the build by removing the type-check step; fix the types.
12. Unused-code detection is ESLint's job here (`@typescript-eslint/no-unused-vars: error`), not tsc's: the Kubb-generated output declares helper types that `noUnusedLocals` would flag, and generated code must never be hand-edited. `src/api/generated/**` is ignored by ESLint and by Prettier.

### UX invariants from the PRD

13. Report views must always render `dataAsOf` and per-outlet sync watermarks / `isProvisional` — stale data must never read as "zero sales" (PRD §8, AT-20).
14. The override editor previews `effectivePriceMinor` (override ?? default) before saving (PRD FR-02).
15. Access token in memory only; refresh stays in the backend's HttpOnly cookie. Never `localStorage`.
