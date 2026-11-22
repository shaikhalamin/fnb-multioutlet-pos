import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DATA_SOURCE } from '../src/database/database.module.js';
import { CatalogChangesService } from '../src/modules/menu/catalog-changes.service.js';
import { configureE2eApp } from './helpers.js';

/**
 * Bulk outlet assignment (FR-02, AT-23) against real PostgreSQL + Redis:
 * `POST /outlets/:outletId/menu` assigns every requested item in ONE
 * transaction — one UPSERT revision per changed item — and commits all of
 * them or none. Row locks make overlapping requests on one outlet serialize
 * instead of racing the assignment upsert (PRD §8.2 rule 5, §8.6).
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

type Item = { id: string; sku: string; name: string; defaultPriceMinor: string };
type ResultRow = {
  menuItemId: string;
  assignmentId: string;
  outcome: 'ASSIGNED' | 'UNCHANGED';
  defaultPriceMinor: string;
  priceOverrideMinor: string | null;
  effectivePriceMinor: string;
  currencyCode: string;
};
type BulkResponse = {
  outletId: string;
  catalogRevision: string;
  assignedCount: number;
  unchangedCount: number;
  items: ResultRow[];
};
type AssignmentRow = {
  menu_item_id: string;
  active: boolean;
  version: number;
  price_override_minor: string | null;
};
type ChangeRow = { revision: string; action: string; payload: Record<string, unknown> };

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describeWithDeps('Bulk outlet assignment (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let analystToken: string;
  let menuManagerToken: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let categoryId: string;
  let outletId: string;
  let outletTwoId: string;
  let items: Item[] = [];
  const throwawayUserIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
    dataSource = app.get<DataSource>(DATA_SOURCE);

    adminToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD })
        .expect(200)
    ).body.data.accessToken;

    const makeUser = async (roleCodes: string[]): Promise<string> => {
      const email = `bulk-${roleCodes[0].toLowerCase()}-${randomUUID().slice(0, 8)}@fnb.local`;
      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, password: 'Bulk123!', roleCodes })
        .expect(201);
      throwawayUserIds.push(created.body.data.id as string);
      return (
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: 'Bulk123!' })
          .expect(200)
      ).body.data.accessToken as string;
    };
    analystToken = await makeUser(['HQ_ANALYST']);
    menuManagerToken = await makeUser(['HQ_MENU_MANAGER']);

    categoryId = (
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Bulk ${tag}`, sortOrder: 0 })
        .expect(201)
    ).body.data.id as string;

    items = [];
    for (const index of [1, 2, 3, 4, 5, 6]) {
      const created = await request(app.getHttpServer())
        .post('/api/v1/menu-items')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `BLK-${tag}-${index}`,
          name: `Bulk item ${index}`,
          categoryId,
          defaultPriceMinor: String(1000 + index * 100),
          currencyCode: 'USD',
        })
        .expect(201);
      items.push({
        id: created.body.data.id as string,
        sku: created.body.data.sku as string,
        name: created.body.data.name as string,
        defaultPriceMinor: created.body.data.defaultPriceMinor as string,
      });
    }

    const provision = async (suffix: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post('/api/v1/outlets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ code: `K${tag}${suffix}`, name: `Bulk outlet ${tag}${suffix}`, timezone: 'UTC' })
          .expect(201)
      ).body.data.id as string;
    outletId = await provision('A');
    outletTwoId = await provision('B');
  });

  afterAll(async () => {
    if (!app) return;
    for (const outlet of [outletId, outletTwoId].filter(Boolean)) {
      await dataSource.query('DELETE FROM outlet_menu_assignments WHERE outlet_id = $1', [outlet]);
      await dataSource.query('DELETE FROM outlet_catalog_changes WHERE outlet_id = $1', [outlet]);
      await dataSource.query('DELETE FROM outlet_catalog_revisions WHERE outlet_id = $1', [outlet]);
      await dataSource.query('DELETE FROM outlets WHERE id = $1', [outlet]);
    }
    if (items.length > 0) {
      await dataSource.query('DELETE FROM master_menu_items WHERE id = ANY($1::uuid[])', [
        items.map((item) => item.id),
      ]);
    }
    if (categoryId) await dataSource.query('DELETE FROM menu_categories WHERE id = $1', [categoryId]);
    for (const userId of throwawayUserIds) {
      await dataSource.query('DELETE FROM hq_refresh_sessions WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM hq_user_roles WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM hq_users WHERE id = $1', [userId]);
    }
    await app.close();
  });

  /** Bearer-authenticated request builders (in supertest the verb comes before headers). */
  const authed = (token: string) => ({
    post: (url: string) => request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => request(app.getHttpServer()).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`),
  });
  const line = (menuItemId: string, priceOverrideMinor?: string | null): object =>
    priceOverrideMinor === undefined ? { menuItemId } : { menuItemId, priceOverrideMinor };
  const bulkAssign = (outlet: string, lines: object[], token: string = adminToken) =>
    authed(token).post(`/api/v1/outlets/${outlet}/menu`).send({ items: lines });

  const revisionOf = async (outlet: string): Promise<bigint> =>
    BigInt(
      (
        await dataSource.query('SELECT current_revision FROM outlet_catalog_revisions WHERE outlet_id = $1', [
          outlet,
        ])
      )[0].current_revision,
    );
  const assignmentRows = async (outlet: string): Promise<AssignmentRow[]> =>
    (await dataSource.query(
      'SELECT menu_item_id, active, version, price_override_minor FROM outlet_menu_assignments WHERE outlet_id = $1',
      [outlet],
    )) as AssignmentRow[];
  const rowOf = async (outlet: string, item: Item): Promise<AssignmentRow | undefined> =>
    (await assignmentRows(outlet)).find((row) => row.menu_item_id === item.id);
  const changeRows = async (outlet: string): Promise<ChangeRow[]> =>
    (await dataSource.query(
      'SELECT revision, action, payload FROM outlet_catalog_changes WHERE outlet_id = $1 ORDER BY revision',
      [outlet],
    )) as ChangeRow[];
  const assignedAuditCount = async (outlet: string): Promise<number> =>
    (
      await dataSource.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'assignment.assigned' AND entity_id IN (SELECT id FROM outlet_menu_assignments WHERE outlet_id = $1)",
        [outlet],
      )
    )[0].count as number;

  it('assigns every item in one commit, one revision per item, in item-ID order', async () => {
    const before = await revisionOf(outletId);
    // Deliberately unsorted: the server owns the order.
    const requested = [items[2], items[0], items[1]];
    const ordered = [...requested].sort(byId);

    const response = await bulkAssign(
      outletId,
      requested.map((item) => line(item.id)),
    ).expect(201);
    const data = response.body.data as BulkResponse;

    expect(data.outletId).toBe(outletId);
    expect(data.assignedCount).toBe(3);
    expect(data.unchangedCount).toBe(0);
    expect(BigInt(data.catalogRevision)).toBe(before + 3n);
    expect(data.items.map((row) => row.menuItemId)).toEqual(ordered.map((item) => item.id));
    for (const [index, item] of ordered.entries()) {
      expect(data.items[index]).toMatchObject({
        outcome: 'ASSIGNED',
        defaultPriceMinor: item.defaultPriceMinor,
        priceOverrideMinor: null,
        effectivePriceMinor: item.defaultPriceMinor,
        currencyCode: 'USD',
      });
      expect(data.items[index].assignmentId).toMatch(/^[0-9a-f-]{36}$/);
    }

    const rows = await assignmentRows(outletId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.active && row.version === 1 && row.price_override_minor === null)).toBe(true);

    const changes = await changeRows(outletId);
    expect(changes.map((change) => change.revision)).toEqual(['1', '2', '3']);
    expect(changes.map((change) => change.action)).toEqual(['UPSERT', 'UPSERT', 'UPSERT']);
    expect(changes.map((change) => change.payload.menuItemId)).toEqual(ordered.map((item) => item.id));
    // The §8.3 snapshot is complete: the outlet never re-derives it from current state.
    expect(changes[0].payload).toMatchObject({
      assignmentId: data.items[0].assignmentId,
      menuItemId: ordered[0].id,
      sku: ordered[0].sku,
      name: ordered[0].name,
      category: `Bulk ${tag}`,
      unitPriceMinor: ordered[0].defaultPriceMinor,
      currencyCode: 'USD',
      active: true,
      itemVersion: 1,
    });
    expect(await assignedAuditCount(outletId)).toBe(3);
  });

  it('is idempotent: a repeated request assigns nothing and burns no revision', async () => {
    const before = await revisionOf(outletId);
    const auditsBefore = await assignedAuditCount(outletId);

    const response = await bulkAssign(
      outletId,
      items.slice(0, 3).map((item) => line(item.id)),
    ).expect(201);
    const data = response.body.data as BulkResponse;

    expect(data.assignedCount).toBe(0);
    expect(data.unchangedCount).toBe(3);
    expect(data.items.every((row) => row.outcome === 'UNCHANGED')).toBe(true);
    expect(BigInt(data.catalogRevision)).toBe(before);
    expect(await revisionOf(outletId)).toBe(before);
    expect(await changeRows(outletId)).toHaveLength(3);
    expect((await assignmentRows(outletId)).every((row) => row.version === 1)).toBe(true);
    expect(await assignedAuditCount(outletId)).toBe(auditsBefore);
  });

  it('reports already-assigned items as UNCHANGED and assigns only the rest', async () => {
    const before = await revisionOf(outletId);

    const response = await bulkAssign(outletId, [line(items[0].id), line(items[5].id)]).expect(201);
    const data = response.body.data as BulkResponse;

    expect(data.assignedCount).toBe(1);
    expect(data.unchangedCount).toBe(1);
    expect(BigInt(data.catalogRevision)).toBe(before + 1n);
    expect(Object.fromEntries(data.items.map((row) => [row.menuItemId, row.outcome]))).toEqual({
      [items[0].id]: 'UNCHANGED',
      [items[5].id]: 'ASSIGNED',
    });
    // Only the new item consumed a revision.
    const changes = await changeRows(outletId);
    expect(changes).toHaveLength(4);
    expect(changes[3].payload.menuItemId).toBe(items[5].id);
    // The unchanged item kept its original version — no blind increment.
    expect(await rowOf(outletId, items[0])).toMatchObject({ active: true, version: 1 });
  });

  it('keeps a stored override and reactivates a soft-unassigned item', async () => {
    const item = items[3];
    const single = authed(adminToken);
    const path = `/api/v1/outlets/${outletId}/menu/${item.id}`;

    // Override $12.00, then soft-unassign: the tombstone keeps the override.
    await single.put(path).send({ active: true, priceOverrideMinor: '1200' }).expect(200);
    await single.delete(path).expect(200);
    expect(await rowOf(outletId, item)).toMatchObject({ active: false, version: 2, price_override_minor: '1200' });

    const before = await revisionOf(outletId);
    const response = await bulkAssign(outletId, [line(item.id)]).expect(201);
    const data = response.body.data as BulkResponse;

    // A line with no priceOverrideMinor keeps the stored override — it applies again.
    expect(data.items[0]).toMatchObject({
      outcome: 'ASSIGNED',
      defaultPriceMinor: item.defaultPriceMinor,
      priceOverrideMinor: '1200',
      effectivePriceMinor: '1200',
    });
    expect(BigInt(data.catalogRevision)).toBe(before + 1n);
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 3, price_override_minor: '1200' });
    expect((await changeRows(outletId)).at(-1)).toMatchObject({
      action: 'UPSERT',
      payload: { menuItemId: item.id, unitPriceMinor: '1200', itemVersion: 1 },
    });
  });

  it('single assign still honours keep / clear / set override semantics and burns no revision on a no-op', async () => {
    const item = items[3];
    const single = authed(adminToken);
    const path = `/api/v1/outlets/${outletId}/menu/${item.id}`;

    // Omitted override keeps the stored one (a no-op here).
    const kept = await single.put(path).send({ active: true }).expect(200);
    expect(kept.body.data.priceOverrideMinor).toBe('1200');

    const before = await revisionOf(outletId);
    await single.put(path).send({ active: true, priceOverrideMinor: '1200' }).expect(200);
    expect(await revisionOf(outletId)).toBe(before);

    // Explicit null clears it; a value sets it.
    const cleared = await single.put(path).send({ active: true, priceOverrideMinor: null }).expect(200);
    expect(cleared.body.data).toMatchObject({ priceOverrideMinor: null, effectivePriceMinor: item.defaultPriceMinor });
    const set = await single.put(path).send({ active: true, priceOverrideMinor: '1500' }).expect(200);
    expect(set.body.data).toMatchObject({
      active: true,
      defaultPriceMinor: item.defaultPriceMinor,
      priceOverrideMinor: '1500',
      effectivePriceMinor: '1500',
      currencyCode: 'USD',
    });
    expect(BigInt(set.body.data.catalogRevision)).toBe(before + 2n);
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 5, price_override_minor: '1500' });
  });

  it('AT-23: rejects the whole batch when one item is archived and commits nothing', async () => {
    const archived = items[4];
    const pending = items[5];
    // Item 6 is soft-unassigned here, so a committed batch would flip it active.
    await authed(adminToken).delete(`/api/v1/outlets/${outletId}/menu/${pending.id}`).expect(200);
    await authed(adminToken).patch(`/api/v1/menu-items/${archived.id}`).send({ status: 'ARCHIVED' }).expect(200);

    const before = await revisionOf(outletId);
    const auditsBefore = await assignedAuditCount(outletId);
    const changesBefore = (await changeRows(outletId)).length;

    const rejected = await bulkAssign(outletId, [line(pending.id), line(archived.id)]).expect(422);
    expect(rejected.body.error.code).toBe('ITEM_INACTIVE');
    expect(rejected.body.error.details.menuItemIds).toEqual([archived.id]);
    expect(rejected.body.error.requestId).toBeTruthy();

    expect(await revisionOf(outletId)).toBe(before);
    expect(await changeRows(outletId)).toHaveLength(changesBefore);
    expect(await rowOf(outletId, pending)).toMatchObject({ active: false, version: 2 });
    expect(await rowOf(outletId, archived)).toBeUndefined();
    expect(await assignedAuditCount(outletId)).toBe(auditsBefore);

    await authed(adminToken).patch(`/api/v1/menu-items/${archived.id}`).send({ status: 'ACTIVE' }).expect(200);
  });

  it('404s unknown items and outlets without committing anything', async () => {
    const before = await revisionOf(outletId);
    const ghost = randomUUID();

    const unknownItem = await bulkAssign(outletId, [line(ghost)]).expect(404);
    expect(unknownItem.body.error.code).toBe('NOT_FOUND');
    expect(unknownItem.body.error.details.menuItemIds).toEqual([ghost]);

    const unknownOutlet = await bulkAssign(randomUUID(), [line(items[4].id)]).expect(404);
    expect(unknownOutlet.body.error.code).toBe('NOT_FOUND');
    expect(unknownOutlet.body.error.message).toBe('Outlet not found.');

    expect(await revisionOf(outletId)).toBe(before);
    expect(await rowOf(outletId, items[4])).toBeUndefined();
  });

  it('validates the items lines with the stable VALIDATION_FAILED code', async () => {
    const cases: object[] = [
      {},
      { items: [] },
      { items: [line(items[0].id), line(items[0].id)] },
      { items: [{ menuItemId: 'not-a-uuid' }] },
      { items: 'nope' },
      { items: Array.from({ length: 201 }, () => line(randomUUID())) },
      { items: [line(items[0].id)], outletId: items[1].id },
      { items: [{ menuItemId: items[0].id, priceOverrideMinor: '12.00' }] },
      { items: [{ menuItemId: items[0].id, priceOverrideMinor: '-5' }] },
      { items: [{ menuItemId: items[0].id, priceOverrideMinor: '1'.repeat(20) }] },
      { items: [{ menuItemId: items[0].id, priceOverrideMinor: 1200 }] },
    ];
    for (const body of cases) {
      const rejected = await authed(adminToken).post(`/api/v1/outlets/${outletId}/menu`).send(body).expect(400);
      expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
    }
    // A null override is a legal line (it clears), and the cap itself passes
    // validation (then 404s on the unknown ids).
    const capped = await authed(adminToken)
      .post(`/api/v1/outlets/${outletId}/menu`)
      .send({ items: Array.from({ length: 200 }, () => line(randomUUID())) });
    expect(capped.status).toBe(404);
  });

  it('enforces assignments.write: anonymous 401, analyst 403, menu manager 201', async () => {
    const anonymous = await request(app.getHttpServer())
      .post(`/api/v1/outlets/${outletTwoId}/menu`)
      .send({ items: [line(items[3].id)] });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const forbidden = await bulkAssign(outletTwoId, [line(items[3].id)], analystToken).expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
    expect(await assignmentRows(outletTwoId)).toHaveLength(0);

    // HQ Menu Manager holds assignments.write (§9.3).
    const allowed = await bulkAssign(outletTwoId, [line(items[3].id)], menuManagerToken).expect(201);
    expect((allowed.body.data as BulkResponse).assignedCount).toBe(1);
    expect(await revisionOf(outletTwoId)).toBe(1n);
  });

  it('rolls back every row when the distribution record cannot be written', async () => {
    const item = items[5];
    const before = await revisionOf(outletId);
    const changesBefore = (await changeRows(outletId)).length;

    // A menu mutation must never commit without its durable distribution
    // record (PRD §8.2 rule 5): fail the change-log append after the
    // assignment row was already written inside the transaction.
    const fanout = app.get(CatalogChangesService);
    const spy = vi.spyOn(fanout, 'appendChanges').mockRejectedValueOnce(new Error('disk full'));
    const failed = await bulkAssign(outletId, [line(item.id)]).expect(500);
    spy.mockRestore();

    expect(failed.body.error.code).toBe('INTERNAL_ERROR');
    expect(failed.body.error.message).toBe('Internal server error.');
    expect(JSON.stringify(failed.body)).not.toContain('disk full');
    expect(await rowOf(outletId, item)).toMatchObject({ active: false, version: 2 });
    expect(await revisionOf(outletId)).toBe(before);
    expect(await changeRows(outletId)).toHaveLength(changesBefore);

    // Nothing was half-applied, so a plain retry succeeds.
    const retried = await bulkAssign(outletId, [line(item.id)]).expect(201);
    expect((retried.body.data as BulkResponse).assignedCount).toBe(1);
    expect(await revisionOf(outletId)).toBe(before + 1n);
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 3 });
  });

  it('serializes overlapping concurrent requests on one outlet', async () => {
    // Items 1–3 were never assigned on this outlet.
    const [a, b, c] = [items[0], items[1], items[2]];
    const base = await revisionOf(outletTwoId);

    // Three overlapping batches race for the same outlet and the same items.
    const responses = await Promise.all([
      bulkAssign(outletTwoId, [line(a.id), line(b.id)]),
      bulkAssign(outletTwoId, [line(b.id), line(c.id)]),
      bulkAssign(outletTwoId, [line(a.id), line(c.id)]),
    ]);
    const totals = responses.reduce(
      (sum, response) => {
        expect(response.status).toBe(201);
        const data = response.body.data as BulkResponse;
        return { assigned: sum.assigned + data.assignedCount, unchanged: sum.unchanged + data.unchangedCount };
      },
      { assigned: 0, unchanged: 0 },
    );
    // Each item was assigned exactly once: three revisions, not six, and no 500s.
    expect(totals).toEqual({ assigned: 3, unchanged: 3 });
    expect(await revisionOf(outletTwoId)).toBe(base + 3n);
    expect(await changeRows(outletTwoId)).toHaveLength(Number(base + 3n));
    for (const item of [a, b, c]) {
      expect(await rowOf(outletTwoId, item)).toMatchObject({ active: true, version: 1 });
    }

    // A single PUT and a bulk assign racing for the same (outlet, item) cost one revision.
    const before = await revisionOf(outletTwoId);
    const [single, bulk] = await Promise.all([
      authed(adminToken).put(`/api/v1/outlets/${outletTwoId}/menu/${items[5].id}`).send({ active: true }),
      bulkAssign(outletTwoId, [line(items[5].id)]),
    ]);
    expect([single.status, bulk.status]).toEqual([200, 201]);
    expect(single.body.data.active).toBe(true);
    expect(await revisionOf(outletTwoId)).toBe(before + 1n);
    expect(await rowOf(outletTwoId, items[5])).toMatchObject({ active: true, version: 1 });
  });

  it('applies per-line prices: set on assign, update, clear, and keep when omitted', async () => {
    const item = items[4]; // never assigned on this outlet
    const active = items[0]; // active with no override, version 1

    const before = await revisionOf(outletId);
    const priced = await bulkAssign(outletId, [line(item.id, '1400'), line(active.id)]).expect(201);
    const pricedData = priced.body.data as BulkResponse;
    expect(pricedData.assignedCount).toBe(1);
    expect(pricedData.unchangedCount).toBe(1);
    expect(pricedData.items.find((row) => row.menuItemId === item.id)).toMatchObject({
      outcome: 'ASSIGNED',
      priceOverrideMinor: '1400',
      effectivePriceMinor: '1400',
    });
    expect(pricedData.items.find((row) => row.menuItemId === active.id)?.outcome).toBe('UNCHANGED');
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 1, price_override_minor: '1400' });
    expect((await changeRows(outletId)).at(-1)).toMatchObject({
      action: 'UPSERT',
      payload: { menuItemId: item.id, unitPriceMinor: '1400' },
    });

    // A new price on an active assignment is a change: ASSIGNED with a bumped version.
    const updated = await bulkAssign(outletId, [line(item.id, '1450')]).expect(201);
    expect((updated.body.data as BulkResponse).items[0]).toMatchObject({
      outcome: 'ASSIGNED',
      priceOverrideMinor: '1450',
      effectivePriceMinor: '1450',
    });
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 2, price_override_minor: '1450' });

    // Explicit null clears back to the master default.
    const cleared = await bulkAssign(outletId, [line(item.id, null)]).expect(201);
    expect((cleared.body.data as BulkResponse).items[0]).toMatchObject({
      outcome: 'ASSIGNED',
      priceOverrideMinor: null,
      effectivePriceMinor: item.defaultPriceMinor,
    });
    expect((await changeRows(outletId)).at(-1)).toMatchObject({
      payload: { menuItemId: item.id, unitPriceMinor: item.defaultPriceMinor },
    });

    // An omitted price keeps the (now cleared) state — a no-op that burns no revision.
    const kept = await bulkAssign(outletId, [line(item.id)]).expect(201);
    expect((kept.body.data as BulkResponse).items[0].outcome).toBe('UNCHANGED');
    expect(await revisionOf(outletId)).toBe(before + 3n);
    expect(await rowOf(outletId, item)).toMatchObject({ active: true, version: 3, price_override_minor: null });
  });
});
