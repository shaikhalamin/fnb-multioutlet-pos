# hq-frontend

HQ administration console for the multi-outlet F&B platform — React 19 SPA
(TanStack Start in SPA mode, Vite, Tailwind), served by its own Nginx which
reverse-proxies `/api/` to `hq-backend`.

## Commands (pnpm via corepack)

```bash
corepack enable
pnpm install
pnpm dev             # Vite dev server (proxies /api to localhost:4000)
pnpm build           # SPA build -> dist/client
pnpm lint && pnpm check
pnpm generate:api    # Kubb: regenerate src/api/generated from src/api/contracts/hq.openapi.json
```

## Phase 1 — auth + catalog console

- **Kubb pipeline** (PRD §11, AGENTS §4.1) — copy the exported contract
  (`hq-backend/openapi/openapi.json` → `src/api/contracts/hq.openapi.json`),
  then `pnpm generate:api` emits typed clients, Zod schemas and TanStack
  Query hooks into `src/api/generated/` (never hand-edited; excluded from
  lint/prettier). The generated runtime's axios instance is configured once
  in `src/api/axios.ts`: `ApiSuccess` envelope unwrap, `X-Request-Id`,
  bearer injection from the in-memory session, and a single-flight
  refresh-and-retry on 401 (never for `/auth/login|refresh`).
- **Session** — access token in memory only (`src/features/auth/session.ts`);
  the rotating refresh token stays in the backend's HttpOnly cookie. Silent
  bootstrap via `POST /auth/refresh` on load (PRD §9.1).
- **Pages** — `/login`; protected `_auth` layout (permission-aware nav);
  `/dashboard` outlets overview; `/menu` categories + items CRUD with
  archive; `/outlets` provisioning; `/outlets/$outletId` assignment matrix
  with the live effective-price preview (FR-02) and the outlet key panel
  (secret shown exactly once); `/users` staff management. Route hiding is
  cosmetic — the backend enforces authorization.
- **Money** — decimal minor-unit strings end-to-end; formatted only at
  render via `formatMinor` (`src/lib/utils.ts`).

## Phase 0 foundation

- **Typed API client** — `src/api/axios.ts`: baseURL from Zod-validated
  `VITE_API_BASE_URL` (`src/lib/env.ts`, build-time public config only),
  `X-Request-Id` per request, `ApiSuccess`/`ApiError` envelope unwrapping
  (PRD §7.1) and a stable `ApiError` type.
- **Query layer** — `src/lib/query-client.ts` shared QueryClient factory;
  business errors (4xx) are never blind-retried (PRD §11).
- **Permissions** — `src/lib/permissions.ts` HQ permission helpers; UI-only,
  the backend always re-validates (PRD §9.3).
- **Contracts** — `src/api/contracts/` is the Kubb source of truth; the
  generation pipeline (pinned Kubb, TS + Axios + Zod + React Query plugins
  into `src/api/generated/`) starts with the first feature contract in
  Phase 1 (PRD §11).
- **Shell** — landing page with a live backend health panel (database/Redis
  status, service version, request ID) refreshed every 30s.

Feature folders (`src/features/auth|menu|assignments|outlets|reports|sync`)
and protected route layouts land with their phases.
