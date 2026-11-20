import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureE2eApp } from './helpers.js';

/**
 * Route rate limiting via @nestjs/throttler (PRD §7.2 "Public with rate
 * limit", §12 RATE_LIMITED): login gets a 5/minute brute-force budget and
 * liveness probes are exempt. This spec boots its own AppModule so its
 * in-memory throttler counters never bleed into the other auth specs.
 * Skipped when the required environment is absent.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';

describeWithDeps('HQ rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns 429 RATE_LIMITED once the login budget (5/minute) is spent', async () => {
    const client = request(app.getHttpServer());

    // The @Throttle budget passes the first five attempts through to the
    // credential check (401 — wrong password, no account-existence leak).
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await client
        .post('/api/v1/auth/login')
        .send({ email: SEED_EMAIL, password: 'definitely-wrong-password' })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }

    const throttled = await client
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: 'definitely-wrong-password' })
      .expect(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
    expect(throttled.body.error.requestId).toBeTruthy();
  });

  it('never throttles the liveness probe (@SkipThrottle)', async () => {
    const client = request(app.getHttpServer());
    for (let probe = 0; probe < 10; probe += 1) {
      await client.get('/api/v1/health').expect(200);
    }
  });
});
