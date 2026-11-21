#!/usr/bin/env bash
# Seed runner (PRD §6.2 outlet bootstrap).
#
# Locally runs the TypeScript seed via tsx; inside the production image (which
# ships only dist/ + production dependencies) runs the compiled JS. The seed
# is idempotent — natural keys make re-runs no-ops.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${NODE_ENV:-}" = "production" ] && [ -f "dist/database/seed.js" ]; then
  exec node "dist/database/seed.js"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
fi
exec pnpm exec tsx src/database/seed.ts
