import request from 'supertest';
import type { App } from 'supertest/types.js';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

/**
 * End-to-end smoke test against the real module graph (PRD §17: integration
 * tests run against real PostgreSQL/Redis containers). Skipped when the
 * required environment is absent, e.g. plain `pnpm test` without services.
 * Inert auth placeholders come from vitest.setup.ts.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

describeWithDeps('Outlet API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns the ApiSuccess envelope with dependency checks', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body.data).toMatchObject({
      status: 'ok',
      service: 'outlet-backend',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
    expect(response.body.meta.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBe(response.body.meta.requestId);
  });

  it('echoes a client-supplied safe X-Request-Id header', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-request-id', 'e2e-42')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('e2e-42');
    expect(response.body.meta.requestId).toBe('e2e-42');
  });
});
