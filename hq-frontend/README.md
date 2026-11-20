# hq-frontend

HQ administration console for the multi-outlet F&B platform — React 19 SPA
(TanStack Start in SPA mode, Vite, Tailwind), served by its own Nginx which
reverse-proxies `/api/` to `hq-backend`.

## Commands (pnpm via corepack)

```bash
corepack enable
pnpm install
pnpm dev             # Vite dev server
pnpm build           # SPA build -> dist/client
pnpm lint && pnpm check
```

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
