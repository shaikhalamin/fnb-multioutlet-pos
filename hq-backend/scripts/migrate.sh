#!/usr/bin/env bash
# Migration wrapper (PRD §14.2/§14.3).
#
# Locally runs the TypeScript CLI via tsx; inside the production image (which
# ships only dist/ + production dependencies) runs the compiled JS. Migrations
# are a single controlled release job — never run concurrently on multiple
# API replicas.
#
# Usage: scripts/migrate.sh [run|revert|show]
set -euo pipefail
cd "$(dirname "$0")/.."

COMMAND="${1:-run}"

if [ "${NODE_ENV:-}" = "production" ] && [ -f "dist/database/migrate.js" ]; then
  exec node "dist/database/migrate.js" "$COMMAND"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
fi
exec pnpm exec tsx src/database/migrate.ts "$COMMAND"
