/**
 * Vitest setup (unit + e2e): supplies inert placeholder environment variables
 * so that merely importing the module graph — which evaluates
 * `ConfigModule.forRoot()` and therefore validates the API environment
 * profile at import time (@nestjs/config v12) — succeeds in every spec.
 *
 * `.env.local` gaps are loaded first (same precedence as the app), so e2e
 * runs against real PostgreSQL/Redis pick up local values; `??=` keeps real
 * environment variables and only the unused auth secrets fall back to
 * placeholders (PRD §17).
 */
import { loadEnvFileGaps } from './src/config/env.schema.js';

loadEnvFileGaps();

process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.HQ_JWT_ISSUER ??= 'vitest-placeholder';
process.env.HQ_JWT_AUDIENCE ??= 'vitest-placeholder';
process.env.JWT_ACCESS_SECRET ??= 'vitest-access-secret-placeholder-0123456789ab';
process.env.JWT_REFRESH_SECRET ??= 'vitest-refresh-secret-placeholder-0123456789ab';
process.env.OUTLET_KEY_PEPPER ??= 'vitest-placeholder-pepper';
