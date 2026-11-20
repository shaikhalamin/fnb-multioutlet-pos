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
  OUTLET_JWT_PRIVATE_KEY: 'dev-private-key',
  OUTLET_JWT_PUBLIC_KEY: 'dev-public-key',
} satisfies Record<string, string | undefined>;

const validWorkerEnv = {
  ...validApiEnv,
  HQ_API_BASE_URL: 'http://localhost:4000/api/v1',
  HQ_OUTLET_KEY_ID: 'ok_live_123',
  HQ_OUTLET_KEY_SECRET: 'dev-secret',
};

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

  it('fails when the outlet identity is missing', () => {
    const { OUTLET_ID: _omitted, ...withoutIdentity } = validApiEnv;
    const result = safeParseEnv(apiEnvSchema, withoutIdentity);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'OUTLET_ID')).toBe(true);
    }
  });

  it('rejects non-postgres database URLs', () => {
    const result = safeParseEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'mysql://localhost/fnb' });
    expect(result.ok).toBe(false);
  });

  it('does not require the HQ machine key (the API never calls HQ)', () => {
    const result = safeParseEnv(apiEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
  });
});

describe('workerEnvSchema', () => {
  it('parses a valid worker environment with sync defaults', () => {
    const result = safeParseEnv(workerEnvSchema, validWorkerEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.MENU_PULL_INTERVAL_MS).toBe(30_000);
      expect(result.env.OUTBOX_BATCH_SIZE).toBe(100);
      expect(result.env.OUTBOX_SWEEP_INTERVAL_MS).toBe(5_000);
      expect(result.env.HEARTBEAT_INTERVAL_MS).toBe(60_000);
    }
  });

  it('requires the HQ machine key configuration', () => {
    const { HQ_OUTLET_KEY_SECRET: _omitted, ...withoutSecret } = validWorkerEnv;
    const result = safeParseEnv(workerEnvSchema, withoutSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'HQ_OUTLET_KEY_SECRET')).toBe(true);
    }
  });

  it('rejects non-http HQ API base URLs', () => {
    const result = safeParseEnv(workerEnvSchema, { ...validWorkerEnv, HQ_API_BASE_URL: 'ftp://hq/api' });
    expect(result.ok).toBe(false);
  });

  it('boots without outlet JWT secrets (PRD §3, §9.2 least privilege)', () => {
    const {
      OUTLET_JWT_ISSUER: _a,
      OUTLET_JWT_AUDIENCE: _b,
      OUTLET_JWT_PRIVATE_KEY: _c,
      OUTLET_JWT_PUBLIC_KEY: _d,
      ...workerEnv
    } = validWorkerEnv;
    const result = safeParseEnv(workerEnvSchema, workerEnv);
    expect(result.ok).toBe(true);
  });
});
