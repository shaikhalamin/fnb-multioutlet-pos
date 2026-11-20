import { describe, expect, it } from 'vitest';
import { apiEnvSchema, safeParseEnv, workerEnvSchema } from './env.schema.js';

const validApiEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://fnb_hq:pw@localhost:5432/fnb_hq',
  REDIS_URL: 'redis://localhost:6379',
  HQ_JWT_ISSUER: 'fnb-hq',
  HQ_JWT_AUDIENCE: 'fnb-hq-api',
  JWT_ACCESS_SECRET: 'dev-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'dev-refresh-secret-0123456789abcdef0123456789',
  OUTLET_KEY_PEPPER: 'dev-pepper',
} satisfies Record<string, string | undefined>;

describe('apiEnvSchema', () => {
  it('parses a valid environment with defaults applied', () => {
    const result = safeParseEnv(apiEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PORT).toBe(3000);
      expect(result.env.ACCESS_TOKEN_TTL).toBe(900);
      expect(result.env.SWAGGER_ENABLED).toBe(false);
      expect(result.env.CORS_ORIGINS).toEqual([]);
    }
  });

  it('splits CORS_ORIGINS into a trimmed array', () => {
    const result = safeParseEnv(apiEnvSchema, { ...validApiEnv, CORS_ORIGINS: 'http://a, http://b' });
    expect(result.ok && result.env.CORS_ORIGINS).toEqual(['http://a', 'http://b']);
  });

  it('fails when a critical variable is missing', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validApiEnv;
    const result = safeParseEnv(apiEnvSchema, withoutDb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'DATABASE_URL')).toBe(true);
    }
  });

  it('rejects non-postgres database URLs', () => {
    const result = safeParseEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'mysql://localhost/fnb' });
    expect(result.ok).toBe(false);
  });

  it('rejects inconsistent token TTLs (refresh must exceed access)', () => {
    const result = safeParseEnv(apiEnvSchema, {
      ...validApiEnv,
      ACCESS_TOKEN_TTL: '900',
      REFRESH_TOKEN_TTL: '60',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'REFRESH_TOKEN_TTL')).toBe(true);
    }
  });

  it('requires the API auth secrets', () => {
    const { JWT_ACCESS_SECRET: _omitted, ...withoutKey } = validApiEnv;
    const result = safeParseEnv(apiEnvSchema, withoutKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'JWT_ACCESS_SECRET')).toBe(true);
    }
  });
});

describe('workerEnvSchema', () => {
  it('boots without any API auth secrets (PRD §3 least privilege)', () => {
    const { HQ_JWT_ISSUER: _a, HQ_JWT_AUDIENCE: _b, JWT_ACCESS_SECRET: _c, JWT_REFRESH_SECRET: _d, OUTLET_KEY_PEPPER: _e, ...workerEnv } = validApiEnv;
    const result = safeParseEnv(workerEnvSchema, workerEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.HEARTBEAT_INTERVAL_MS).toBe(60_000);
    }
  });
});
