# API contracts (Kubb source of truth)

This folder holds the machine-readable OpenAPI documents the Kubb generation
pipeline consumes (PRD §11):

- `hq.openapi.json` — copied/exported from `hq-backend/openapi/openapi.json`

The pipeline (pinned Kubb version, TS + Axios + Zod + React Query plugins
writing to `src/api/generated/`) lands with the first feature contract in
Phase 1. Until then `src/api/axios.ts` plus the hand-written envelope types
in `src/types/api.ts` are the only API surface.

Rules (PRD §11): never manually maintain conflicting API types; always
regenerate `src/api/generated/` after a contract change; sensitive
key-issuance endpoints are internal/admin and never included in generated
frontend code.
