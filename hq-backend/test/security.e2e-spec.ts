import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module.js';
import { DATA_SOURCE } from '../src/database/database.module.js';
import { parseApiEnv } from '../src/config/env.schema.js';
import { configureE2eApp } from './helpers.js';

/**
 * Phase-4 security sweep against real PostgreSQL (AT-17): the forged-token
 * matrix (wrong secret / issuer / audience / expired / disabled user → 401),
 * the §9.3 permission matrix with seeded-role tokens, and the human/machine
 * credential crossovers. Cross-issuer isolation is proven by issuer/audience
 * validation with independently provisioned secrets (§9.1) — an outlet-issuer
 * token is just another wrong-`iss` token here.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

describeWithDeps('HQ security surface (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let env: ReturnType<typeof parseApiEnv>;
  let adminToken: string;
  let adminUserId: string;
  let analystToken: string;
  let menuManagerToken: string;
  let outletId: string;
  const throwawayUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
    dataSource = app.get<DataSource>(DATA_SOURCE);
    env = parseApiEnv();

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
      .expect(200);
    adminToken = adminLogin.body.data.accessToken;
    adminUserId = adminLogin.body.data.user.id;

    const makeUser = async (roleCodes: string[]): Promise<{ id: string; token: string }> => {
      const email = `sec-${roleCodes[0]?.toLowerCase()}-${randomUUID().slice(0, 8)}@fnb.local`;
      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, password: 'Secure123!', roleCodes })
        .expect(201);
      const id = (created.body.data as { id: string }).id;
      throwawayUserIds.push(id);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'Secure123!' })
        .expect(200);
      return { id, token: login.body.data.accessToken as string };
    };

    const analyst = await makeUser(['HQ_ANALYST']);
    analystToken = analyst.token;
    menuManagerToken = (await makeUser(['HQ_MENU_MANAGER'])).token;

    outletId = (
      (
        await request(app.getHttpServer())
          .get('/api/v1/outlets')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200)
      ).body.data as Array<{ id: string }>
    )[0].id;
  });

  afterAll(async () => {
    if (!app) return;
    for (const userId of throwawayUserIds) {
      await dataSource.query('DELETE FROM hq_refresh_sessions WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM hq_user_roles WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM hq_users WHERE id = $1', [userId]);
    }
    await app.close();
  });

  /** Signs an access-token-shaped JWT with the given (possibly wrong) params. */
  const forge = (overrides: { secret?: string; issuer?: string; audience?: string; expiresIn?: string | number }) =>
    new JwtService({
      secret: overrides.secret ?? env.JWT_ACCESS_SECRET,
      signOptions: {
        algorithm: 'HS256',
        issuer: overrides.issuer ?? env.HQ_JWT_ISSUER,
        audience: overrides.audience ?? env.HQ_JWT_AUDIENCE,
        ...(overrides.expiresIn ? { expiresIn: overrides.expiresIn } : {}),
      },
    }).signAsync({ roleCodes: ['HQ_SUPER_ADMIN'] }, { subject: adminUserId, jwtid: randomUUID() });

  const expectUnauthenticated = async (token: string, url = '/api/v1/menu-items') => {
    const response = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  };

  // ---- Forged-token matrix ----------------------------------------------------

  it('401s tokens signed with the wrong secret', async () => {
    await expectUnauthenticated(await forge({ secret: 'x'.repeat(48) }));
  });

  it('401s tokens with the wrong issuer — including outlet-issued tokens (§9.1 isolation)', async () => {
    await expectUnauthenticated(await forge({ issuer: 'fnb-outlet' }));
    await expectUnauthenticated(await forge({ issuer: 'https://evil.example' }));
  });

  it('401s tokens with the wrong audience', async () => {
    await expectUnauthenticated(await forge({ audience: 'fnb-outlet-api' }));
    await expectUnauthenticated(await forge({ audience: 'https://evil.example' }));
  });

  it('401s expired tokens', async () => {
    await expectUnauthenticated(await forge({ expiresIn: -60 }));
  });

  it('401s a well-signed token whose user has been disabled since issuance', async () => {
    const email = `sec-disabled-${randomUUID().slice(0, 8)}@fnb.local`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password: 'Secure123!', roleCodes: ['HQ_MENU_MANAGER'] })
      .expect(201);
    const userId = (created.body.data as { id: string }).id;
    throwawayUserIds.push(userId);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'Secure123!' })
      .expect(200);
    const token = login.body.data.accessToken as string;

    await request(app.getHttpServer()).get('/api/v1/menu-items').set('Authorization', `Bearer ${token}`).expect(200);
    await dataSource.query("UPDATE hq_users SET status = 'DISABLED' WHERE id = $1", [userId]);
    await expectUnauthenticated(token);
  });

  // ---- §9.3 permission matrix ---------------------------------------------------

  it('analysts read reports but cannot write the menu; menu managers cannot manage keys or read reports', async () => {
    // Analyst: reports OK (200)…
    await request(app.getHttpServer())
      .get('/api/v1/reports/revenue-by-outlet?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z')
      .set('Authorization', `Bearer ${analystToken}`)
      .expect(200);

    // …menu write forbidden.
    const menuWrite = await request(app.getHttpServer())
      .post('/api/v1/menu-items')
      .set('Authorization', `Bearer ${analystToken}`)
      .send({
        sku: `SEC-${randomUUID().slice(0, 6)}`,
        name: 'Forbidden item',
        categoryId: randomUUID(),
        defaultPriceMinor: '900',
        currencyCode: 'USD',
      })
      .expect(403);
    expect(menuWrite.body.error.code).toBe('FORBIDDEN');

    // Menu manager: key issuance forbidden…
    const keyIssue = await request(app.getHttpServer())
      .post(`/api/v1/outlets/${outletId}/api-keys`)
      .set('Authorization', `Bearer ${menuManagerToken}`)
      .send({})
      .expect(403);
    expect(keyIssue.body.error.code).toBe('FORBIDDEN');

    // …and reports (no reports.read) forbidden.
    const reportRead = await request(app.getHttpServer())
      .get('/api/v1/reports/revenue-by-outlet?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z')
      .set('Authorization', `Bearer ${menuManagerToken}`)
      .expect(403);
    expect(reportRead.body.error.code).toBe('FORBIDDEN');
  });

  // ---- Human/machine credential crossovers --------------------------------------

  it('never accepts an outlet machine key on human routes (401, not 403)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/menu-items')
      .set('Authorization', 'OutletKey some-key-id.some-secret')
      .expect(401)
      .expect((res) => expect(res.body.error.code).toBe('UNAUTHENTICATED'));
  });

  it('never accepts a human bearer JWT on machine sync routes (§9.2 no crossover)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(401)
      .expect((res) => expect(res.body.error.code).toBe('UNAUTHENTICATED'));
  });

  it('hides unknown outlets behind 404 on sync-status (no cross-outlet leak)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/outlets/${randomUUID()}/sync-status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404)
      .expect((res) => expect(res.body.error.code).toBe('NOT_FOUND'));
  });
});
