# API contracts (Kubb source of truth)

This folder holds the machine-readable OpenAPI documents the Kubb generation
pipeline consumes (PRD §11):

- `outlet.openapi.json` — copied/exported from `outlet-backend/openapi/openapi.json`

The pipeline (pinned Kubb version, TS + Axios + Zod + React Query plugins
writing to `src/api/generated/`) lands with the first feature contract in
Phase 2. Until then `src/api/axios.ts` plus the hand-written envelope types
in `src/types/api.ts` are the only API surface.

Rules (PRD §11): never manually maintain conflicting API types; always
regenerate `src/api/generated/` after a contract change; the typed machine
client for HQ sync endpoints lives in the outlet backend only — never in
frontend code.
