import { describe, expect, it } from 'vitest';
import { apiEnvSchema, safeParseEnv, workerEnvSchema } from './env.schema.js';

const validApiEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://fnb_outlet_a:pw@localhost:5432/fnb_outlet_a',
  REDIS_URL: 'redis://localhost:6379',
  OUTLET_ID: '11111111-1111-4111-8111-111111111111',
  OUTLET_CODE: 'A',
  OUTLET_JWT_ISSUER: 'fnb-outlet',
  OUTLET_JWT_AUDIENCE: 'fnb-outlet-api',
  OUTLET_JWT_ACCESS_SECRET: 'dev-access-secret-0123456789abcdef0123456789',
  OUTLET_JWT_REFRESH_SECRET: 'dev-refresh-secret-0123456789abcdef0123456789',
} satisfies Record<string, string | undefined>;

describe('apiEnvSchema', () => {
  it('parses a valid environment with defaults applied', () => {
    const result = safeParseEnv(apiEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PORT).toBe(3000);
      expect(result.env.OFFLINE_GRACE_HOURS).toBe(72);
      expect(result.env.SWAGGER_ENABLED).toBe(false);
    }
  });

  it('boots without outlet identity — the terminal awaits setup-wizard provisioning', () => {
    const { OUTLET_ID: _id, OUTLET_CODE: _code, ...withoutIdentity } = validApiEnv;
    const result = safeParseEnv(apiEnvSchema, withoutIdentity);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.OUTLET_ID).toBeUndefined();
      expect(result.env.OUTLET_CODE).toBeUndefined();
    }
  });

  it('still validates the identity shape when provided (dev seed path)', () => {
    const result = safeParseEnv(apiEnvSchema, { ...validApiEnv, OUTLET_ID: 'not-a-uuid' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'OUTLET_ID')).toBe(true);
    }
  });

  it('rejects non-postgres database URLs', () => {
    const result = safeParseEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'mysql://localhost/fnb' });
    expect(result.ok).toBe(false);
  });
});

describe('workerEnvSchema', () => {
  it('parses a valid worker environment with sync defaults', () => {
    const result = safeParseEnv(workerEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.MENU_PULL_INTERVAL_MS).toBe(30_000);
      expect(result.env.OUTBOX_BATCH_SIZE).toBe(100);
      expect(result.env.OUTBOX_SWEEP_INTERVAL_MS).toBe(5_000);
      expect(result.env.HEARTBEAT_INTERVAL_MS).toBe(60_000);
    }
  });

  it('boots unpaired: no HQ credentials in the environment anymore (setup wizard owns them)', () => {
    const {
      OUTLET_JWT_ISSUER: _a,
      OUTLET_JWT_AUDIENCE: _b,
      OUTLET_JWT_ACCESS_SECRET: _c,
      OUTLET_JWT_REFRESH_SECRET: _d,
      OUTLET_ID: _e,
      OUTLET_CODE: _f,
      ...unpairedWorkerEnv
    } = validApiEnv;
    const result = safeParseEnv(workerEnvSchema, unpairedWorkerEnv);
    expect(result.ok).toBe(true);
  });
});
