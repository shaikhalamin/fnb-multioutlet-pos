#!/usr/bin/env bash
# Seed runner: idempotent HQ bootstrap (company, permissions, default roles,
# super admin) plus local demo catalog data (PRD §6.1, Phase 1).
#
# Environment: DATABASE_URL (required); SEED_HQ_ADMIN_EMAIL,
# SEED_HQ_ADMIN_PASSWORD, SEED_COMPANY_NAME, SEED_DEMO_DATA (optional).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f dist/database/seed.js ] && [ "${NODE_ENV:-}" = "production" ]; then
  exec node dist/database/seed.js
fi
exec pnpm exec tsx src/database/seed.ts
