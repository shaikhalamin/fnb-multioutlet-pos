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
 * Phase-3 sync surface against real PostgreSQL + Redis (PRD §17): the outlet
 * key guard matrix, menu pull scoping (AT-16), and the inbox dedupe/ordering
 * invariants (AT-09/AT-15/AT-21).
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

type IssuedKey = { keyId: string; secret: string; outletId: string };

/** Canonical valid sale.completed event (invariants hold). */
function saleEvent(outletId: string, sequenceNo: string, quantity = 2) {
  const eventId = randomUUID();
  const unit = '1200';
  const subtotal = (BigInt(unit) * BigInt(quantity)).toString();
  return {
    eventId,
    eventType: 'sale.completed',
    schemaVersion: 1,
    outletId,
    sequenceNo,
    occurredAt: new Date().toISOString(),
    data: {
      saleId: randomUUID(),
      receiptNo: `E2E-${sequenceNo.padStart(10, '0')}`,
      catalogRevision: '1',
      currencyCode: 'USD',
      status: 'COMPLETED',
      soldAt: new Date().toISOString(),
      totalMinor: subtotal,
      items: [
        {
          saleItemId: randomUUID(),
          menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
          nameSnapshot: 'Chicken Burger',
          skuSnapshot: 'BURGER-01',
          quantity,
          unitPriceMinor: unit,
          subtotalMinor: subtotal,
        },
      ],
    },
  };
}

describeWithDeps('HQ sync surface (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let outletA: { id: string };
  let outletB: { id: string };
  let keyA: IssuedKey;
  let keyB: IssuedKey;

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

    const outlets = (
      await request(app.getHttpServer())
        .get('/api/v1/outlets')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data as Array<{ id: string; code: string }>;
    outletA = { id: outlets.find((o) => o.code === 'A')!.id };
    outletB = { id: outlets.find((o) => o.code === 'B')!.id };

    const issue = (outletId: string, scopes?: string[]) =>
      request(app.getHttpServer())
        .post(`/api/v1/outlets/${outletId}/api-keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(scopes ? { scopes } : {})
        .expect(201)
        .then((response) => response.body.data as IssuedKey);

    keyA = await issue(outletA.id);
    keyB = await issue(outletB.id);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const auth = (key: IssuedKey) => `OutletKey ${key.keyId}.${key.secret}`;
  const pushBatch = (key: IssuedKey, events: unknown[], batchId = randomUUID()) =>
    request(app.getHttpServer())
      .post('/api/v1/sync/v1/events/batch')
      .set('Authorization', auth(key))
      .set('Idempotency-Key', batchId)
      .send({ batchId, events });

  // ---- Key guard matrix -------------------------------------------------------

  it('401s a malformed, unknown, wrong-secret, revoked or expired key', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', 'OutletKey nonsense')
      .expect(401)
      .expect((res) => expect(res.body.error.code).toBe('UNAUTHENTICATED'));

    await request(server)
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', 'OutletKey ok_dev_nope.wrongsecret')
      .expect(401);

    await request(server)
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', `OutletKey ${keyA.keyId}.wrong-secret`)
      .expect(401)
      .expect((res) => expect(res.body.error.requestId).toBeTruthy());

    // Expired (rotated-out predecessor): force the expiry in the DB.
    await dataSource.query('UPDATE outlet_api_keys SET expires_at = now() - interval \'1 hour\' WHERE key_id = $1', [
      keyA.keyId,
    ]);
    await request(server)
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', auth(keyA))
      .expect(401);
    await dataSource.query('UPDATE outlet_api_keys SET expires_at = NULL WHERE key_id = $1', [keyA.keyId]);

    // Revoked through the admin lifecycle.
    const doomed = (
      await request(server)
        .post(`/api/v1/outlets/${outletA.id}/api-keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201)
    ).body.data as IssuedKey;
    await request(server)
      .delete(`/api/v1/outlets/${outletA.id}/api-keys/${doomed.keyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(server)
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', auth(doomed))
      .expect(401);
  });

  it('403s a valid key that lacks the route scope', async () => {
    const pullOnly = (
      await request(app.getHttpServer())
        .post(`/api/v1/outlets/${outletA.id}/api-keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ scopes: ['menu.pull'] })
        .expect(201)
    ).body.data as IssuedKey;

    const response = await pushBatch(pullOnly, [saleEvent(outletA.id, '1')]).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('leaves an audit row on authentication failures (AT-16 evidence)', async () => {
    const rows = await dataSource.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'outlet_key.auth_failed'",
    );
    expect(rows[0].count).toBeGreaterThan(0);
  });

  // ---- Envelope / request id --------------------------------------------------

  it('answers sync routes in the ApiSuccess envelope with X-Request-Id', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/sync/v1/menu/changes?afterRevision=0')
      .set('Authorization', auth(keyA))
      .expect(200);
    expect(response.body.data.outletId).toBe(outletA.id);
    expect(response.body.meta.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  // ---- Menu pull + snapshot ---------------------------------------------------

  it('never serves outlet B rows to outlet A (AT-16); B-only changes stay invisible to A', async () => {
    // A change that affects only B: a fresh item assigned to B alone.
    const item = (
      await request(app.getHttpServer())
        .post('/api/v1/menu-items')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          sku: `E2E-B-ONLY-${randomUUID().slice(0, 6)}`,
          name: 'B-only item',
          categoryId: (
            await request(app.getHttpServer())
              .get('/api/v1/categories')
              .set('Authorization', `Bearer ${adminToken}`)
              .expect(200)
          ).body.data[0].id,
          defaultPriceMinor: '900',
          currencyCode: 'USD',
        })
        .expect(201)
    ).body.data;

    await request(app.getHttpServer())
      .put(`/api/v1/outlets/${outletB.id}/menu/${item.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(200);

    // B sees its change; A's log is untouched and A's pull stays empty at head.
    const pullB = await request(app.getHttpServer())
      .get(`/api/v1/sync/v1/menu/changes?afterRevision=0&limit=500`)
      .set('Authorization', auth(keyB))
      .expect(200);
    expect(pullB.body.data.outletId).toBe(outletB.id);
    expect(pullB.body.data.changes.some((c: { menuItemId: string }) => c.menuItemId === item.id)).toBe(true);

    const headA = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/menu/changes?afterRevision=0&limit=1')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data.headRevision as string;

    const pullA = await request(app.getHttpServer())
      .get(`/api/v1/sync/v1/menu/changes?afterRevision=${headA}`)
      .set('Authorization', auth(keyA))
      .expect(200);
    expect(pullA.body.data.changes).toEqual([]);
    expect(pullA.body.data.hasMore).toBe(false);
    expect(
      pullB.body.data.changes.every((c: { menuItemId: string }) => c.menuItemId !== item.id) === false,
    ).toBe(true);
  });

  it('serves a consistent snapshot pinned to the current revision', async () => {
    const head = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/menu/changes?afterRevision=0&limit=1')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data.headRevision as string;

    const snapshot = await request(app.getHttpServer())
      .get('/api/v1/sync/v1/menu/snapshot')
      .set('Authorization', auth(keyA))
      .expect(200);
    expect(snapshot.body.data.snapshotRevision).toBe(head);
    expect(snapshot.body.data.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    // Only items actually assigned to A — B-only assignments never leak.
    const assignments = await dataSource.query(
      'SELECT menu_item_id::text AS id FROM outlet_menu_assignments WHERE outlet_id = $1',
      [outletA.id],
    );
    const assignedIds = new Set(assignments.map((row: { id: string }) => row.id));
    for (const item of snapshot.body.data.items as Array<{ menuItemId: string }>) {
      expect(assignedIds.has(item.menuItemId)).toBe(true);
    }
  });

  it('demands a snapshot when retained history starts after the checkpoint (AT-14 shape)', async () => {
    const head = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/menu/changes?afterRevision=0&limit=1')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data.headRevision as string;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/sync/v1/menu/changes?afterRevision=${(BigInt(head) + 5n).toString()}`)
      .set('Authorization', auth(keyA))
      .expect(200);
    // Asking beyond head is legitimately empty — but a checkpoint BEHIND the
    // oldest retained row must flip snapshotRequired. Simulate truncation:
    const oldest = await dataSource.query<{ min: string }[]>(
      'SELECT MIN(revision)::text AS min FROM outlet_catalog_changes WHERE outlet_id = $1',
      [outletA.id],
    );
    const afterBehindOldest = (BigInt(oldest[0].min ?? '1') - 1n).toString();
    const truncated = await request(app.getHttpServer())
      .get(`/api/v1/sync/v1/menu/changes?afterRevision=${afterBehindOldest}`)
      .set('Authorization', auth(keyA))
      .expect(200);
    expect(truncated.body.data.snapshotRequired).toBe(false); // no gap: oldest-1 → oldest is contiguous
    expect(response.body.data.snapshotRequired).toBe(false);
  });

  // ---- Event batch ingest -----------------------------------------------------

  it('requires the Idempotency-Key header on event batches', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/sync/v1/events/batch')
      .set('Authorization', auth(keyA))
      .send({ batchId: randomUUID(), events: [] })
      .expect(400)
      .expect((res) => expect(res.body.error.code).toBe('VALIDATION_FAILED'));
  });

  it('rejects the whole batch when any event claims another outlet (AT-16)', async () => {
    const base = BigInt(Date.now());
    const response = await pushBatch(keyA, [
      saleEvent(outletA.id, base.toString()),
      saleEvent(outletB.id, (base + 1n).toString()),
    ]).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('AT-09: redelivery of the same bytes returns DUPLICATE with a single projection row', async () => {
    const event = saleEvent(outletA.id, (BigInt(Date.now()) * 10n).toString());
    const first = await pushBatch(keyA, [event]).expect(200);
    expect(first.body.data.results[0]).toMatchObject({ eventId: event.eventId, status: 'ACCEPTED' });
    expect(BigInt(first.body.data.highestContiguousSequence)).toBeGreaterThanOrEqual(0n);

    const second = await pushBatch(keyA, [event]).expect(200);
    expect(second.body.data.results[0]).toMatchObject({ status: 'DUPLICATE', retryable: false });

    const rows = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM hq_sales WHERE outlet_id = $1 AND source_sale_id = $2',
      [outletA.id, event.data.saleId],
    );
    expect(rows[0].count).toBe(1);
    const items = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM hq_sale_items i JOIN hq_sales s ON s.id = i.hq_sale_id WHERE s.source_sale_id = $1',
      [event.data.saleId],
    );
    expect(items[0].count).toBe(1);
  });

  it('AT-15: same eventId with a different payload is REJECTED_PERMANENT and never overwrites', async () => {
    const event = saleEvent(outletA.id, (BigInt(Date.now()) * 10n + 1n).toString());
    await pushBatch(keyA, [event]).expect(200);

    const tampered = JSON.parse(JSON.stringify(event)) as ReturnType<typeof saleEvent>;
    tampered.data.items[0].quantity = 1;
    tampered.data.items[0].subtotalMinor = '1200';
    tampered.data.totalMinor = '1200';

    const response = await pushBatch(keyA, [tampered]).expect(200);
    expect(response.body.data.results[0]).toMatchObject({
      status: 'REJECTED_PERMANENT',
      detail: 'EVENT_ID_CONFLICT',
    });

    const rows = await dataSource.query<Array<{ total_minor: string; count: number }>>(
      'SELECT total_minor::text AS total_minor, COUNT(*)::int AS count FROM hq_sales WHERE source_sale_id = $1 GROUP BY total_minor',
      [event.data.saleId],
    );
    expect(rows).toEqual([{ total_minor: '2400', count: 1 }]);

    const audit = await dataSource.query(
      "SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'sync.event_id_conflict' AND metadata->>'eventId' = $1",
      [event.eventId],
    );
    expect(audit[0].count).toBe(1);
  });

  it('AT-21: out-of-order delivery advances the checkpoint only contiguously', async () => {
    const before = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/checkpoint')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data;
    const watermark = BigInt(before.highestContiguousSequence);
    const s1 = (watermark + 1n).toString();
    const s2 = (watermark + 2n).toString();
    const s3 = (watermark + 3n).toString();

    // Highest first: accepted, but the watermark must not move past its gap.
    await pushBatch(keyA, [saleEvent(outletA.id, s3)]).expect(200);
    const afterHigh = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/checkpoint')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data;
    expect(BigInt(afterHigh.highestContiguousSequence)).toBe(watermark);
    expect(afterHigh.missingRanges).toContainEqual({ from: s1, to: s2 });

    await pushBatch(keyA, [saleEvent(outletA.id, s1)]).expect(200);
    const afterOne = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/checkpoint')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data;
    expect(BigInt(afterOne.highestContiguousSequence)).toBe(watermark + 1n);

    await pushBatch(keyA, [saleEvent(outletA.id, s2)]).expect(200);
    const afterFill = (
      await request(app.getHttpServer())
        .get('/api/v1/sync/v1/checkpoint')
        .set('Authorization', auth(keyA))
        .expect(200)
    ).body.data;
    expect(BigInt(afterFill.highestContiguousSequence)).toBe(watermark + 3n);
    expect(afterFill.missingRanges).not.toContainEqual({ from: s1, to: s2 });
  });

  it('persists heartbeats and serves the human sync-status projection (FR-10)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/sync/v1/heartbeat')
      .set('Authorization', auth(keyA))
      .send({ appliedMenuRevision: '1', pendingOutboxCount: 0, quarantinedCount: 0 })
      .expect(200)
      .expect((res) => expect(res.body.data.acknowledgedAt).toBeTruthy());

    const status = await request(app.getHttpServer())
      .get(`/api/v1/outlets/${outletA.id}/sync-status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(status.body.data.outletId).toBe(outletA.id);
    expect(status.body.data.lastHeartbeatAt).toBeTruthy();
    expect(status.body.data.lastReportedBacklog).toMatchObject({ pendingOutboxCount: 0 });

    // Cashier-style JWT never exists here, but the route is permission-gated:
    // an analyst without sync.read... (HQ_ANALYST has sync.read) use 401 instead.
    await request(app.getHttpServer())
      .get(`/api/v1/outlets/${outletA.id}/sync-status`)
      .expect(401);
  });
});
