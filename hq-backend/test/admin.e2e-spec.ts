import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureE2eApp } from './helpers.js';

/**
 * Phase-1 admin surface against real PostgreSQL + Redis (PRD §17): RBAC
 * enforcement (AT-17 flavor), users/outlets CRUD, catalog fan-out (AT-01),
 * price overrides (AT-02), and the outlet key lifecycle (§9.2).
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

describeWithDeps('HQ admin surface (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let analystToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();

    adminToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
        .expect(200)
    ).body.data.accessToken;

    // Provision a throwaway HQ Analyst to prove permission denial.
    const analystEmail = `analyst-${randomUUID().slice(0, 8)}@fnb.local`;
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
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- RBAC (AT-17 flavor) ---------------------------------------------------

  it('rejects unauthenticated access to guarded routes', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/menu-items').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('forbids an analyst from menu writes with the stable FORBIDDEN code', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/menu-items')
      .set('Authorization', `Bearer ${analystToken}`)
      .send({})
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('lets the analyst read outlets but not provision one', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${analystToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/outlets')
      .set('Authorization', `Bearer ${analystToken}`)
      .send({ code: 'ZZ', name: 'Nope', timezone: 'UTC' })
      .expect(403);
  });

  // ---- Catalog + assignment fan-out (AT-01 / AT-02) --------------------------

  it('exposes seeded demo catalog and outlets', async () => {
    const items = await request(app.getHttpServer())
      .get('/api/v1/menu-items?status=ACTIVE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const burger = items.body.data.find((item: { sku: string }) => item.sku === 'BURGER-01');
    expect(burger).toBeTruthy();
    // Normalize any drift from earlier runs so the suite is re-run safe.
    if (burger.defaultPriceMinor !== '1000') {
      await request(app.getHttpServer())
        .patch(`/api/v1/menu-items/${burger.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ defaultPriceMinor: '1000' })
        .expect(200);
      burger.defaultPriceMinor = '1000';
    }
    expect(burger.defaultPriceMinor).toBe('1000');

    const outlets = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(outlets.body.data.map((outlet: { code: string }) => outlet.code).sort()).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('AT-01: assigns the burger to A and B only; C never sees it', async () => {
    const items = await request(app.getHttpServer())
      .get('/api/v1/menu-items?q=BURGER-01')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const burger = items.body.data[0];
    const outlets = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const byCode = new Map(outlets.body.data.map((o: { code: string; id: string }) => [o.code, o.id]));
    const revisionBefore = new Map(
      outlets.body.data.map((o: { code: string; catalogRevision: string }) => [o.code, o.catalogRevision]),
    );

    // AT-02 setup: outlet B sells at the $12.00 override; A at the $10.00 default.
    // (Reset any prior override state first so the test is re-run safe.)
    const assignedA = await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('A')}/menu/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true, priceOverrideMinor: null })
      .expect(200);
    expect(assignedA.body.data.effectivePriceMinor).toBe('1000');
    expect(assignedA.body.data.defaultPriceMinor).toBe('1000');

    // Two distinct override PUTs guarantee state changes on every run
    // (each run ends at 1200, so 1199 always differs) — deterministic
    // revision bumps even when the suite re-runs against a used database.
    const stepOne = await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('B')}/menu/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true, priceOverrideMinor: '1199' })
      .expect(200);
    const assignedB = await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('B')}/menu/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true, priceOverrideMinor: '1200' })
      .expect(200);
    expect(stepOne.body.data.effectivePriceMinor).toBe('1199');
    expect(assignedB.body.data.priceOverrideMinor).toBe('1200');
    expect(assignedB.body.data.effectivePriceMinor).toBe('1200');
    expect(BigInt(assignedB.body.data.catalogRevision)).toBe(
      BigInt(revisionBefore.get('B') ?? '0') + 2n,
    );

    // Matrix view shows per-outlet effective prices.
    const menuA = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${byCode.get('A')}/menu`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rowA = menuA.body.data.find((row: { menuItemId: string }) => row.menuItemId === burger.id);
    expect(rowA.effectivePriceMinor).toBe('1000');

    const menuB = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${byCode.get('B')}/menu`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rowB = menuB.body.data.find((row: { menuItemId: string }) => row.menuItemId === burger.id);
    expect(rowB.effectivePriceMinor).toBe('1200');

    const menuC = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${byCode.get('C')}/menu`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(menuC.body.data.some((row: { menuItemId: string }) => row.menuItemId === burger.id)).toBe(
      false,
    );
  });

  it('item edit fans out a new UPSERT revision with the snapshot; no-op PUT burns none', async () => {
    const items = await request(app.getHttpServer())
      .get('/api/v1/menu-items?q=BURGER-01')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const burger = items.body.data[0];
    const outlets = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const byCode = new Map(outlets.body.data.map((o: { code: string; id: string }) => [o.code, o.id]));

    // Price change: A follows the new default, B keeps her override.
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/menu-items/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ defaultPriceMinor: '1100' })
      .expect(200);
    expect(updated.body.data.version).toBe(burger.version + 1);

    const menuB = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${byCode.get('B')}/menu`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rowB = menuB.body.data.find((row: { menuItemId: string }) => row.menuItemId === burger.id);
    expect(rowB.effectivePriceMinor).toBe('1200'); // override still wins (FR-02/AT-02)

    // Same-state PUT must not consume a revision.
    const revisionsBefore = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const bBefore = revisionsBefore.body.data.find((o: { code: string }) => o.code === 'B').catalogRevision;
    await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('B')}/menu/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true, priceOverrideMinor: '1200' })
      .expect(200);
    const revisionsAfter = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const bAfter = revisionsAfter.body.data.find((o: { code: string }) => o.code === 'B').catalogRevision;
    expect(bAfter).toBe(bBefore);

    // Restore the seeded default for the next run.
    await request(app.getHttpServer())
      .patch(`/api/v1/menu-items/${burger.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ defaultPriceMinor: '1000' })
      .expect(200);
  });

  it('unassign emits REMOVE and archives fan out REMOVE changes', async () => {
    const items = await request(app.getHttpServer())
      .get('/api/v1/menu-items?q=PIZZA-01')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const pizza = items.body.data[0];
    const outlets = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const byCode = new Map(outlets.body.data.map((o: { code: string; id: string }) => [o.code, o.id]));

    await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('A')}/menu/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(200);

    const unassigned = await request(app.getHttpServer())
      .delete(`/api/v1/outlets/${byCode.get('A')}/menu/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(unassigned.body.data.active).toBe(false);

    // Archiving a still-assigned item fans REMOVE to its active outlets.
    await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('B')}/menu/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(200);
    const archived = await request(app.getHttpServer())
      .patch(`/api/v1/menu-items/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    // Archived items cannot be actively assigned (ITEM_INACTIVE).
    const rejected = await request(app.getHttpServer())
      .put(`/api/v1/outlets/${byCode.get('C')}/menu/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(422);
    expect(rejected.body.error.code).toBe('ITEM_INACTIVE');

    // Restore for later suites.
    await request(app.getHttpServer())
      .patch(`/api/v1/menu-items/${pizza.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
  });

  it('validates money as decimal strings and rejects unknown fields', async () => {
    const bad = await request(app.getHttpServer())
      .post('/api/v1/menu-items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `BAD-${randomUUID().slice(0, 6)}`,
        name: 'Bad',
        categoryId: '00000000-0000-4000-8000-000000000000',
        defaultPriceMinor: '10.50',
        currencyCode: 'USD',
      })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SEED_EMAIL, password: SEED_PASSWORD, hackerField: true })
      .expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_FAILED');
  });

  // ---- Users -----------------------------------------------------------------

  it('creates a user, refuses duplicates, and lists roles', async () => {
    const roles = await request(app.getHttpServer())
      .get('/api/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(roles.body.data.map((role: { code: string }) => role.code)).toContain('HQ_MENU_MANAGER');

    const email = `manager-${randomUUID().slice(0, 8)}@fnb.local`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password: 'Manager123!', roleCodes: ['HQ_MENU_MANAGER'] })
      .expect(201);
    expect(created.body.data.roleCodes).toEqual(['HQ_MENU_MANAGER']);
    expect(created.body.data.passwordHash).toBeUndefined();

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, password: 'Manager123!', roleCodes: ['HQ_MENU_MANAGER'] })
      .expect(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    const unknownRole = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `x-${randomUUID().slice(0, 6)}@fnb.local`, password: 'Manager123!', roleCodes: ['NOPE'] })
      .expect(422);
    expect(unknownRole.body.error.code).toBe('UNPROCESSABLE_ENTITY');
  });

  // ---- Outlet API keys (§9.2) --------------------------------------------------

  it('issues a key showing the secret once, rotates with overlap, revokes', async () => {
    const outlets = await request(app.getHttpServer())
      .get('/api/v1/outlets')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const outlet = outlets.body.data.find((o: { code: string }) => o.code === 'A');

    const issued = await request(app.getHttpServer())
      .post(`/api/v1/outlets/${outlet.id}/api-keys`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
    expect(issued.body.data.keyId).toMatch(/^ok_(dev|live)_[0-9a-f]{16}$/);
    expect(issued.body.data.secret).toHaveLength(43); // 256-bit base64url
    expect(issued.body.data.scopes).toEqual(['menu.pull', 'events.push', 'status.write']);

    // Listing never leaks secret material.
    const listed = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${outlet.id}/api-keys`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.data.secret);
    expect(listed.body.data[0].keyId).toBe(issued.body.data.keyId);

    const rotated = await request(app.getHttpServer())
      .post(`/api/v1/outlets/${outlet.id}/api-keys/${issued.body.data.keyId}/rotate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graceHours: 2 })
      .expect(201);
    expect(rotated.body.data.rotatedFromKeyId).toBe(issued.body.data.keyId);

    await request(app.getHttpServer())
      .delete(`/api/v1/outlets/${outlet.id}/api-keys/${rotated.body.data.keyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Analysts cannot manage keys.
    await request(app.getHttpServer())
      .get(`/api/v1/outlets/${outlet.id}/api-keys`)
      .set('Authorization', `Bearer ${analystToken}`)
      .expect(403);
  });
});
