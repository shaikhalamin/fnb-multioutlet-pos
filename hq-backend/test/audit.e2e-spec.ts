import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DATA_SOURCE } from '../src/database/database.module.js';
import { configureE2eApp } from './helpers.js';

/**
 * Phase-4 audit surface against real PostgreSQL (PRD §11 audit views,
 * FR-10): auth events (login failures, refresh-token reuse, key rotation)
 * land in the immutable trail and are readable through `GET /audit/logs`
 * with filters and deterministic cursor paging — and only by super admins.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

type IssuedKey = { keyId: string; secret: string };

describeWithDeps('HQ audit surface (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let adminUserId: string;
  let analystToken: string;
  let auditUserId: string;
  let rotatedKeyId: string;
  let outletId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
    dataSource = app.get<DataSource>(DATA_SOURCE);

    // Re-seed the permission catalog idempotently (the documented step for
    // existing HQ databases; mirrors `pnpm seed` for the new permission).
    await dataSource.query(
      `INSERT INTO hq_permissions (id, code, description)
       VALUES (gen_random_uuid(), 'audit.read', '')
       ON CONFLICT (code) DO NOTHING`,
    );
    await dataSource.query(
      `INSERT INTO hq_role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM hq_roles r, hq_permissions p
       WHERE r.code = 'HQ_SUPER_ADMIN' AND p.code = 'audit.read'
       ON CONFLICT DO NOTHING`,
    );

    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
      .expect(200);
    adminToken = adminLogin.body.data.accessToken;
    adminUserId = adminLogin.body.data.user.id;

    // A throwaway analyst proves the §9.3 denial (analysts have no audit row).
    const analystEmail = `audit-analyst-${randomUUID().slice(0, 8)}@fnb.local`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: analystEmail, password: 'Analyst123!', roleCodes: ['HQ_ANALYST'] })
      .expect(201);
    analystToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: analystEmail, password: 'Analyst123!' })
        .expect(200)
    ).body.data.accessToken;

    // A throwaway user generates login-failure + refresh-reuse audit rows.
    auditUserId = (
      (
        await request(app.getHttpServer())
          .post('/api/v1/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            email: `audit-actor-${randomUUID().slice(0, 8)}@fnb.local`,
            password: 'Actor123!',
            roleCodes: ['HQ_ANALYST'],
          })
          .expect(201)
      ).body.data as { id: string }
    ).id;
    const actorEmail = (
      await dataSource.query<Array<{ email: string }>>('SELECT email FROM hq_users WHERE id = $1', [auditUserId])
    )[0].email;
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: actorEmail, password: 'wrong-password' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: actorEmail, password: 'wrong-password-2' })
      .expect(401);

    // Refresh-token reuse: rotate with the first cookie, then replay it.
    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: actorEmail, password: 'Actor123!' })
      .expect(200);
    const firstCookie = loginA.headers['set-cookie'] as string[];
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', firstCookie) // reuse — family revoked + audited
      .expect(401);

    // Key rotation on a throwaway outlet.
    outletId = (
      (
        await request(app.getHttpServer())
          .post('/api/v1/outlets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ code: `AU${randomUUID().slice(0, 4)}`, name: 'Audit outlet', timezone: 'UTC' })
          .expect(201)
      ).body.data as { id: string }
    ).id;
    const key = (
      await request(app.getHttpServer())
        .post(`/api/v1/outlets/${outletId}/api-keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201)
    ).body.data as IssuedKey;
    rotatedKeyId = key.keyId;
    await request(app.getHttpServer())
      .post(`/api/v1/outlets/${outletId}/api-keys/${key.keyId}/rotate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
  });

  afterAll(async () => {
    if (!app) return;
    // Throwaway users/outlets keep the shared dev DB tidy for re-runs.
    await dataSource.query('DELETE FROM hq_refresh_sessions WHERE user_id = $1', [auditUserId]);
    await dataSource.query('DELETE FROM hq_user_roles WHERE user_id = $1', [auditUserId]);
    await dataSource.query('DELETE FROM hq_users WHERE id = $1', [auditUserId]);
    await app.close();
  });

  const authed = (url: string, token = adminToken) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  it('denies analysts the audit surface (§9.3 — audit.read is super-admin-only)', async () => {
    const response = await authed('/api/v1/audit/logs', analystToken).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details).toMatchObject({ requiredPermissions: ['audit.read'] });
  });

  it('lists newest-first and walks the deterministic cursor without duplicates', async () => {
    const pageSize = 3;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let previousOccurredAt: string | undefined;
    do {
      const url = `/api/v1/audit/logs?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await authed(url).expect(200);
      const rows = response.body.data as Array<{ id: string; occurredAt: string }>;
      for (const row of rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
        if (previousOccurredAt) {
          expect(row.occurredAt.localeCompare(previousOccurredAt)).toBeLessThanOrEqual(0);
        }
        previousOccurredAt = row.occurredAt;
      }
      cursor = response.body.meta.nextCursor as string | undefined;
      pages += 1;
    } while (cursor && pages < 50);
    expect(seen.size).toBeGreaterThan(pageSize);
  });

  it('filters by action and actorId: login failures carry the email, successes the actor id', async () => {
    // Failed logins are SYSTEM-actor rows (actorId null by design — the
    // actor is unauthenticated); the email lives in metadata.
    const failures = await authed('/api/v1/audit/logs?action=auth.login_failed&limit=100').expect(200);
    const failureRows = failures.body.data as Array<{
      actorType: string;
      actorId: string | null;
      action: string;
      metadata: Record<string, unknown>;
    }>;
    const actorEmail = (
      await dataSource.query<Array<{ email: string }>>('SELECT email FROM hq_users WHERE id = $1', [auditUserId])
    )[0].email;
    const mine = failureRows.filter((row) => row.metadata.email === actorEmail);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((row) => row.actorType === 'SYSTEM' && row.actorId === null)).toBe(true);

    // Successful logins are USER rows filterable by actorId.
    const successes = await authed(`/api/v1/audit/logs?action=auth.login_succeeded&actorId=${auditUserId}`).expect(
      200,
    );
    const successRows = successes.body.data as Array<{ actorId: string | null }>;
    expect(successRows.length).toBeGreaterThanOrEqual(1);
    expect(successRows.every((row) => row.actorId === auditUserId)).toBe(true);
  });

  it('records the refresh-reuse detection and the key rotation', async () => {
    const reuse = await authed(`/api/v1/audit/logs?action=auth.refresh_reuse_detected&actorId=${auditUserId}`).expect(
      200,
    );
    expect((reuse.body.data as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Rotation audits entityId = the key ROW id; the predecessor keyId string
    // lives in metadata.
    const rotate = await authed('/api/v1/audit/logs?action=outlet_key.rotated&limit=20').expect(200);
    const rows = rotate.body.data as Array<{ action: string; metadata: Record<string, unknown> }>;
    expect(
      rows.some((row) => row.metadata.predecessorKeyId === rotatedKeyId),
    ).toBe(true);
  });

  it('honors the occurred_at window filters', async () => {
    const future = await authed('/api/v1/audit/logs?from=2999-01-01T00:00:00Z&to=3000-01-01T00:00:00Z').expect(200);
    expect(future.body.data).toEqual([]);
    const past = await authed('/api/v1/audit/logs?from=2000-01-01T00:00:00Z&to=2999-01-01T00:00:00Z&limit=5').expect(
      200,
    );
    expect((past.body.data as unknown[]).length).toBeGreaterThan(0);
  });

  it('clamps the page size and exposes admin activity for the current actor', async () => {
    const clamp = await authed('/api/v1/audit/logs?limit=1000').expect(400);
    expect(clamp.body.error.code).toBe('VALIDATION_FAILED');

    const mine = await authed(`/api/v1/audit/logs?actorId=${adminUserId}&limit=100`).expect(200);
    const actions = (mine.body.data as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toContain('outlet.created');
  });
});
