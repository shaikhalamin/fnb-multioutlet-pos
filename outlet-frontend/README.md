# outlet-frontend

Outlet point-of-sale UI for the multi-outlet F&B platform — React 19 SPA
(TanStack Start in SPA mode, Vite, Tailwind), served by its own Nginx which
reverse-proxies `/api/` to the outlet backend.

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
  (PRD §7.1) and a stable `ApiError` type. Checkout flows (Phase 2) will
  reuse one `Idempotency-Key` across retries — never mint a second key.
- **Query layer** — `src/lib/query-client.ts` shared QueryClient factory;
  no optimistic UI for financial data (PRD §11).
- **Permissions** — `src/lib/permissions.ts` outlet permission helpers;
  UI-only, the backend always re-validates (PRD §9.3).
- **Contracts** — `src/api/contracts/` is the Kubb source of truth; the
  generation pipeline starts with the first feature contract in Phase 2
  (PRD §11). Machine sync credentials live only in the outlet worker —
  never in this app.
- **Shell** — landing page with a live terminal-health panel (local
  database/queue status) refreshed every 30s.

Feature folders (`src/features/auth|pos|inventory|sales|receipts|sync-status`)
land with their phases.
