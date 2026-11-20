/**
 * Vitest setup (unit + e2e): supplies inert placeholder environment variables
 * so that merely importing the module graph — which evaluates
 * `ConfigModule.forRoot()` and therefore validates the API environment
 * profile at import time (@nestjs/config v12) — succeeds in every spec.
 *
 * `??=` keeps real values: e2e runs against real PostgreSQL/Redis provide
 * DATABASE_URL/REDIS_URL externally (PRD §17) and only the unused Phase 0
 * auth secrets fall back to placeholders.
 */
process.env.DATABASE_URL ??= 'postgresql://vitest:vitest@localhost:5432/vitest';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.HQ_JWT_ISSUER ??= 'vitest-placeholder';
process.env.HQ_JWT_AUDIENCE ??= 'vitest-placeholder';
process.env.HQ_JWT_PRIVATE_KEY ??= 'vitest-placeholder-key';
process.env.HQ_JWT_PUBLIC_KEY ??= 'vitest-placeholder-key';
process.env.OUTLET_KEY_PEPPER ??= 'vitest-placeholder-pepper';
