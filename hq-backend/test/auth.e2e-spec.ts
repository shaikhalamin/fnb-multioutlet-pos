import request from 'supertest';
import type { App } from 'supertest/types.js';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureE2eApp } from './helpers.js';

/**
 * Auth lifecycle against real PostgreSQL + Redis (PRD §17): login, rotating
 * refresh cookie, family revocation on reuse (AT-18), and logout. Skipped
 * when the required environment is absent.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

function cookieOf(response: request.Response, name: string): string | undefined {
  const setCookie = response.headers['set-cookie'] ?? [];
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const [key, value] = pair.split('=');
    if (key === name) return value;
  }
  return undefined;
}

describeWithDeps('HQ auth (e2e)', () => {
  let app: INestApplication<App>;

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

  it('rejects wrong credentials with 401 UNAUTHENTICATED and no cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: 'definitely-wrong-password' })
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect(response.body.error.requestId).toBeTruthy();
    expect(cookieOf(response, 'hq_rt')).toBeUndefined();
  });

  it('rejects a malformed login body with VALIDATION_FAILED', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  let accessToken: string;
  let refreshToken: string;

  it('logs in the seeded admin: envelope, session user, HttpOnly refresh cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
      .expect(200);

    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.tokenType).toBe('Bearer');
    expect(response.body.data.expiresInSeconds).toBeGreaterThan(0);
    expect(response.body.data.user.email).toBe(SEED_EMAIL);
    expect(response.body.data.user.roleCodes).toContain('HQ_SUPER_ADMIN');
    expect(response.body.data.user.permissions).toContain('menu.write');
    // The refresh token must never appear in the JSON body (PRD §9.1).
    expect(JSON.stringify(response.body)).not.toContain('refreshToken');

    const setCookie = (response.headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toContain('hq_rt=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth');
    expect(setCookie).toContain('SameSite=Lax');

    accessToken = response.body.data.accessToken;
    refreshToken = cookieOf(response, 'hq_rt') as string;
    expect(refreshToken).toBeTruthy();
  });

  it('rotates the refresh cookie and returns a fresh access token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`hq_rt=${refreshToken}`])
      .expect(200);

    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.accessToken).not.toBe(accessToken);
    const newRefreshToken = cookieOf(response, 'hq_rt') as string;
    expect(newRefreshToken).toBeTruthy();
    expect(newRefreshToken).not.toBe(refreshToken);

    // The just-retired token must now be treated as reused (AT-18).
    const reuse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`hq_rt=${refreshToken}`])
      .expect(401);
    expect(reuse.body.error.code).toBe('UNAUTHENTICATED');

    // Family revocation kills the successor too: stolen lineage is dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`hq_rt=${newRefreshToken}`])
      .expect(401);
  });

  it('rejects refresh without a cookie', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/refresh').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('logout requires authentication and revokes the family', async () => {
    // Fresh login for an isolated family.
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
      .expect(200);
    const token = login.body.data.accessToken as string;
    const cookie = cookieOf(login, 'hq_rt') as string;

    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', [`hq_rt=${cookie}`])
      .expect(200);

    // Family revoked: the cookie is now dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`hq_rt=${cookie}`])
      .expect(401);
  });
});
