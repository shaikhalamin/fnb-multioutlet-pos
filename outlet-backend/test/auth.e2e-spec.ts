import request from 'supertest';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureE2eApp, type E2eApp, SEEDED_USERS } from './helpers.js';

/**
 * Outlet auth lifecycle against real PostgreSQL + Redis (PRD §17): login,
 * rotating refresh cookie, family revocation on reuse (AT-18 behavior), and
 * logout. Skipped when the required environment is absent.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

function cookieOf(response: request.Response, name: string): string | undefined {
  const setCookie = response.headers['set-cookie'] ?? [];
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    const [key, value] = pair.split('=');
    if (key === name) return value;
  }
  return undefined;
}

describeWithDeps('Outlet auth (e2e)', () => {
  let app: E2eApp;

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
      .send({ email: SEEDED_USERS.cashier.email, password: 'definitely-wrong-password' })
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect(response.body.error.requestId).toBeTruthy();
    expect(cookieOf(response, 'outlet_rt')).toBeUndefined();
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

  it('logs in the seeded cashier: envelope, outletId claim identity, HttpOnly cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEEDED_USERS.cashier.email, password: SEEDED_USERS.cashier.password })
      .expect(200);

    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.tokenType).toBe('Bearer');
    expect(response.body.data.user.email).toBe(SEEDED_USERS.cashier.email);
    expect(response.body.data.user.roleCodes).toContain('OUTLET_CASHIER');
    expect(response.body.data.user.permissions).toContain('sales.create');
    // PRD §9.1 login example: the user carries the provisioned outletId.
    expect(response.body.data.user.outletId).toBe(process.env.OUTLET_ID);
    // The refresh token must never appear in the JSON body (PRD §9.1).
    expect(JSON.stringify(response.body)).not.toContain('refreshToken');

    const setCookie = (response.headers['set-cookie'] ?? []).join('\n');
    expect(setCookie).toContain('outlet_rt=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth');
    expect(setCookie).toContain('SameSite=Lax');

    accessToken = response.body.data.accessToken;
    refreshToken = cookieOf(response, 'outlet_rt') as string;
    expect(refreshToken).toBeTruthy();
  });

  it('serves the POS menu to the authenticated cashier', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/menu')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.meta.catalogRevision).toBe('1');
    expect(response.body.meta.lastCatalogSyncAt).toBeTruthy();
  });

  it('requires authentication: no token ⇒ 401 on guarded routes', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/menu').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rotates the refresh cookie; reuse of the retired token kills the family', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`outlet_rt=${refreshToken}`])
      .expect(200);

    expect(response.body.data.accessToken).toBeTruthy();
    expect(response.body.data.accessToken).not.toBe(accessToken);
    const newRefreshToken = cookieOf(response, 'outlet_rt') as string;
    expect(newRefreshToken).not.toBe(refreshToken);

    // The just-retired token must now be treated as reused (AT-18).
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`outlet_rt=${refreshToken}`])
      .expect(401);

    // Family revocation kills the successor too: stolen lineage is dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`outlet_rt=${newRefreshToken}`])
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
      .send({ email: SEEDED_USERS.cashier.email, password: SEEDED_USERS.cashier.password })
      .expect(200);
    const token = login.body.data.accessToken as string;
    const cookie = cookieOf(login, 'outlet_rt') as string;

    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', [`outlet_rt=${cookie}`])
      .expect(200);

    // Family revoked: the cookie is now dead.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`outlet_rt=${cookie}`])
      .expect(401);
  });
});
