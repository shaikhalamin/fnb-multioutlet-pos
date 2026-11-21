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
 * Phase-4 reporting surface against real PostgreSQL (PRD §10, AT-20): exact
 * decimal-string totals from the HQ projections, window boundary semantics,
 * zero-sale outlets disclosed, staleness (`dataAsOf`/`isProvisional`) never
 * letting unsynced sales read as zero, top-items ranking/tie-break/isolation.
 *
 * Deterministic under the live sync worker: every fixture lives on throwaway
 * outlets whose sales carry `soldAt` inside a fixed far-past window (the live
 * loop always sells "now"), and the throwaways are suspended in `afterAll` so
 * re-runs converge (suspended outlets leave the ACTIVE report list).
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const SEED_EMAIL = process.env.SEED_HQ_ADMIN_EMAIL ?? 'admin@fnb.local';
const SEED_PASSWORD = process.env.SEED_HQ_ADMIN_PASSWORD ?? 'Admin123!';

const WINDOW_FROM = '2020-06-01T00:00:00Z';
const WINDOW_TO = '2020-07-01T00:00:00Z';

const BURGER = '9708835e-2e21-465a-87e9-5f8d56cd44ab';
const PIZZA = 'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4';
const COLA = '3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110';
// Unknown to the master catalog on purpose: exercises the name_snapshot
// fallback; sorts after PIZZA so the tie at qty 3 proves the id tie-break.
const GHOST = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type IssuedKey = { keyId: string; secret: string; outletId: string };

let seqCounter = BigInt(Date.now()) * 1000n;
const nextSequence = (): string => {
  seqCounter += 1n;
  return seqCounter.toString();
};

function saleEvent(args: {
  outletId: string;
  soldAt: string;
  receiptSuffix: string;
  lines: Array<{ menuItemId: string; name: string; sku: string; quantity: number; unitPriceMinor: string }>;
}) {
  const total = args.lines.reduce(
    (sum, line) => sum + BigInt(line.unitPriceMinor) * BigInt(line.quantity),
    0n,
  );
  return {
    eventId: randomUUID(),
    eventType: 'sale.completed',
    schemaVersion: 1,
    outletId: args.outletId,
    sequenceNo: nextSequence(),
    occurredAt: args.soldAt,
    data: {
      saleId: randomUUID(),
      receiptNo: `E2ER-${args.receiptSuffix}-${seqCounter.toString().slice(-8)}`,
      catalogRevision: '1',
      currencyCode: 'USD',
      status: 'COMPLETED',
      soldAt: args.soldAt,
      totalMinor: total.toString(),
      items: args.lines.map((line) => ({
        saleItemId: randomUUID(),
        menuItemId: line.menuItemId,
        nameSnapshot: line.name,
        skuSnapshot: line.sku,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        subtotalMinor: (BigInt(line.unitPriceMinor) * BigInt(line.quantity)).toString(),
      })),
    },
  };
}

describeWithDeps('HQ reporting surface (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let outletR1: { id: string };
  let outletR2: { id: string };
  let outletR3: { id: string };
  let keyR1: IssuedKey;
  let keyR2: IssuedKey;

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

    const createOutlet = (code: string, name: string) =>
      request(app.getHttpServer())
        .post('/api/v1/outlets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code, name, timezone: 'UTC' })
        .expect(201)
        .then((response) => response.body.data as { id: string });

    const run = randomUUID().slice(0, 4).toUpperCase();
    outletR1 = await createOutlet(`R1${run}`, 'Reporting R1');
    outletR2 = await createOutlet(`R2${run}`, 'Reporting R2');
    outletR3 = await createOutlet(`R3${run}`, 'Reporting R3 (never reports)');

    const issue = (outletId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/outlets/${outletId}/api-keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(201)
        .then((response) => response.body.data as IssuedKey);
    keyR1 = await issue(outletR1.id);
    keyR2 = await issue(outletR2.id);

    const push = (key: IssuedKey, events: unknown[]) =>
      request(app.getHttpServer())
        .post('/api/v1/sync/v1/events/batch')
        .set('Authorization', `OutletKey ${key.keyId}.${key.secret}`)
        .set('Idempotency-Key', randomUUID())
        .send({ batchId: randomUUID(), events })
        .expect(200)
        .then((response) => response.body.data as { results: Array<{ status: string }> });

    // R1 fixture: a > 2^53 fixture sale, boundary sales at both window edges,
    // a cola sale that shares the window with the boundary-from one, and a
    // ghost item unknown to the master catalog.
    const pushes = await push(keyR1, [
      saleEvent({
        outletId: outletR1.id,
        soldAt: '2020-06-10T12:00:00Z',
        receiptSuffix: 'BIG',
        lines: [{ menuItemId: BURGER, name: 'Chicken Burger', sku: 'BURGER-01', quantity: 1, unitPriceMinor: '9007199254740993' }],
      }),
      saleEvent({
        outletId: outletR1.id,
        soldAt: '2020-06-15T12:00:00Z',
        receiptSuffix: 'PIZ',
        lines: [{ menuItemId: PIZZA, name: 'Pizza', sku: 'PIZZA-01', quantity: 3, unitPriceMinor: '1500' }],
      }),
      saleEvent({
        // soldAt exactly = from → INCLUDED (from is inclusive).
        outletId: outletR1.id,
        soldAt: WINDOW_FROM,
        receiptSuffix: 'EDG',
        lines: [{ menuItemId: COLA, name: 'Cola', sku: 'COLA-01', quantity: 2, unitPriceMinor: '300' }],
      }),
      saleEvent({
        // soldAt exactly = to → EXCLUDED (to is exclusive).
        outletId: outletR1.id,
        soldAt: WINDOW_TO,
        receiptSuffix: 'TOO',
        lines: [{ menuItemId: BURGER, name: 'Chicken Burger', sku: 'BURGER-01', quantity: 4, unitPriceMinor: '1000' }],
      }),
      saleEvent({
        outletId: outletR1.id,
        soldAt: '2020-06-20T12:00:00Z',
        receiptSuffix: 'MIX',
        lines: [
          { menuItemId: COLA, name: 'Cola', sku: 'COLA-01', quantity: 3, unitPriceMinor: '300' },
          { menuItemId: GHOST, name: 'Ghost Gadget', sku: 'GHOST-01', quantity: 3, unitPriceMinor: '500' },
        ],
      }),
    ]);
    expect(pushes.results.every((result) => result.status === 'ACCEPTED')).toBe(true);

    // R2 fixture (isolation target): one burger sale only.
    const pushedR2 = await push(keyR2, [
      saleEvent({
        outletId: outletR2.id,
        soldAt: '2020-06-20T12:00:00Z',
        receiptSuffix: 'ISO',
        lines: [{ menuItemId: BURGER, name: 'Chicken Burger', sku: 'BURGER-01', quantity: 2, unitPriceMinor: '1000' }],
      }),
    ]);
    expect(pushedR2.results.every((result) => result.status === 'ACCEPTED')).toBe(true);
    // R3 never reports anything.
  });

  afterAll(async () => {
    if (!app) return;
    // Suspend the throwaways so future report runs (and re-runs of this
    // spec) are unaffected: suspended outlets leave the ACTIVE report list.
    for (const outlet of [outletR1, outletR2, outletR3]) {
      if (!outlet?.id) continue;
      await request(app.getHttpServer())
        .patch(`/api/v1/outlets/${outlet.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'SUSPENDED' })
        .expect(200);
    }
    await app.close();
  });

  const revenueQuery = () =>
    `/api/v1/reports/revenue-by-outlet?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`;

  /** SQL mirror of the §10 staleness contract — the API must agree with it. */
  const sqlIsProvisional = async (): Promise<boolean> => {
    const rows = await dataSource.query<Array<{ provisional: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM outlets o
         WHERE o.status = 'ACTIVE'
           AND (
             NOT EXISTS (SELECT 1 FROM hq_sales s WHERE s.outlet_id = o.id)
             OR COALESCE((
                 SELECT (c.last_reported_backlog->>'pendingOutboxCount')::int
                 FROM sync_outlet_checkpoints c WHERE c.outlet_id = o.id
               ), 0) > 0
           )
       ) AS provisional`,
    );
    return rows[0]?.provisional === true;
  };

  it('revenue totals match pushed events exactly as decimal strings, with window boundaries honored (AT-20/AT-02 shape)', async () => {
    const report = (
      await request(app.getHttpServer())
        .get(revenueQuery())
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data as {
      currencyCode: string;
      outlets: Array<{
        outletId: string;
        totalRevenueMinor: string;
        completedSaleCount: number;
        lastIngestedAt: string | null;
      }>;
      totalRevenueMinor: string;
    };

    expect(report.currencyCode).toBe('USD');
    const byId = new Map(report.outlets.map((outlet) => [outlet.outletId, outlet]));

    // 9007199254740993 + 4500 + 600 + (900 + 1500) — float math would corrupt
    // this sum; the to-exclusive sale (4000) must be absent (4 sales in-window).
    expect(byId.get(outletR1.id)).toMatchObject({
      totalRevenueMinor: '9007199254748493',
      completedSaleCount: 4,
    });
    expect(byId.get(outletR2.id)).toMatchObject({ totalRevenueMinor: '2000', completedSaleCount: 1 });
    // Cross-check against SQL over the same window (bigint, authoritative).
    const sql = await dataSource.query<Array<{ total: string; count: number }>>(
      `SELECT SUM(total_minor)::text AS total, COUNT(*)::int AS count
       FROM hq_sales WHERE outlet_id = $1 AND status = 'COMPLETED'
         AND sold_at >= $2 AND sold_at < $3`,
      [outletR1.id, WINDOW_FROM, WINDOW_TO],
    );
    expect(sql[0].total).toBe('9007199254748493');
    expect(sql[0].count).toBe(4);
    expect(BigInt(report.totalRevenueMinor)).toBe(
      BigInt('9007199254748493') + BigInt('2000'),
    );
  });

  it('includes the never-reporting ACTIVE outlet as 0 / never-reported, never as "no sales" (AT-20)', async () => {
    const report = (
      await request(app.getHttpServer())
        .get(revenueQuery())
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data;
    const outlet = report.outlets.find((o: { outletId: string }) => o.outletId === outletR3.id);
    expect(outlet).toBeDefined();
    expect(outlet).toMatchObject({ totalRevenueMinor: '0', completedSaleCount: 0, lastIngestedAt: null });
    // Reported outlets carry their all-time watermark, not a window-bound one.
    const reported = report.outlets.find((o: { outletId: string }) => o.outletId === outletR1.id);
    expect(reported?.lastIngestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('dataAsOf tracks the max ingested_at at read time', async () => {
    const before = (
      await dataSource.query<Array<{ max: string | null }>>('SELECT MAX(ingested_at)::text AS max FROM hq_sales')
    )[0].max;
    const report = (
      await request(app.getHttpServer())
        .get(revenueQuery())
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data;
    const after = (
      await dataSource.query<Array<{ max: string | null }>>('SELECT MAX(ingested_at)::text AS max FROM hq_sales')
    )[0].max;
    expect(report.dataAsOf).toBeTruthy();
    if (before && after) {
      expect(new Date(report.dataAsOf).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(new Date(report.dataAsOf).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    }
  });

  it('isProvisional agrees with the §10 contract on live data and flips on reported backlog (AT-20)', async () => {
    const heartbeat = (key: IssuedKey, pendingOutboxCount: number) =>
      request(app.getHttpServer())
        .post('/api/v1/sync/v1/heartbeat')
        .set('Authorization', `OutletKey ${key.keyId}.${key.secret}`)
        .send({ appliedMenuRevision: '1', pendingOutboxCount, quarantinedCount: 0 })
        .expect(200);

    const matchesSql = async (): Promise<boolean> => {
      const report = (
        await request(app.getHttpServer())
          .get(revenueQuery())
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200)
      ).body.data;
      return report.isProvisional === (await sqlIsProvisional());
    };

    // Branch-scoped mirror: the backlog dimension alone. R3 keeps the
    // report-level flag true throughout (never ingested), so the AT-20 flip
    // is proven on this isolated branch — deterministic because every other
    // suite heartbeats 0 and suspends its throwaway outlets.
    const sqlBacklogReported = async (): Promise<boolean> => {
      const rows = await dataSource.query<Array<{ backlog: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM sync_outlet_checkpoints c
           JOIN outlets o ON o.id = c.outlet_id
           WHERE o.status = 'ACTIVE'
             AND (c.last_reported_backlog->>'pendingOutboxCount')::int > 0
         ) AS backlog`,
      );
      return rows[0]?.backlog === true;
    };

    // Baseline: the API mirrors the contract definition on whatever the
    // shared DB currently holds (other outlets included), with no outlet
    // currently reporting a backlog.
    expect(await matchesSql()).toBe(true);
    expect(await sqlBacklogReported()).toBe(false);

    // A reported backlog flips the report provisional and both SQL mirrors
    // agree — this is the AT-20 "stale, not zero" disclosure.
    await heartbeat(keyR1, 3);
    expect(await sqlBacklogReported()).toBe(true);
    const withBacklog = (
      await request(app.getHttpServer())
        .get(revenueQuery())
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data;
    expect(withBacklog.isProvisional).toBe(true);
    expect(await sqlIsProvisional()).toBe(true);

    // Draining the backlog restores the mirrored state and clears the branch.
    await heartbeat(keyR1, 0);
    expect(await sqlBacklogReported()).toBe(false);
    expect(await matchesSql()).toBe(true);
  });

  it('ranks top items by quantitySold DESC with the menu-item-id tie-break and snapshot-name fallback', async () => {
    const report = (
      await request(app.getHttpServer())
        .get(
          `/api/v1/reports/outlets/${outletR1.id}/top-items?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data as {
      outletId: string;
      items: Array<{ rank: number; menuItemId: string; itemName: string; quantitySold: number }>;
      dataAsOf: string | null;
    };

    expect(report.outletId).toBe(outletR1.id);
    // cola 5 (2 boundary + 3 mixed) > pizza 3 = ghost 3 (id tie-break, ghost
    // sorts after pizza) > burger 1 (the to-exclusive sale must be absent).
    expect(report.items).toEqual([
      { rank: 1, menuItemId: COLA, itemName: 'Cola', quantitySold: 5 },
      { rank: 2, menuItemId: PIZZA, itemName: 'Pizza', quantitySold: 3 },
      { rank: 3, menuItemId: GHOST, itemName: 'Ghost Gadget', quantitySold: 3 },
      { rank: 4, menuItemId: BURGER, itemName: 'Chicken Burger', quantitySold: 1 },
    ]);
    expect(report.dataAsOf).toBeTruthy();
  });

  it('caps top items at the V1 limit and isolates outlets from each other', async () => {
    const limited = (
      await request(app.getHttpServer())
        .get(
          `/api/v1/reports/outlets/${outletR1.id}/top-items?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}&limit=2`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data;
    expect(limited.items.map((item: { menuItemId: string }) => item.menuItemId)).toEqual([COLA, PIZZA]);

    // R2 sees ONLY its own burger sale — R1's rows never leak across outlets.
    const r2 = (
      await request(app.getHttpServer())
        .get(
          `/api/v1/reports/outlets/${outletR2.id}/top-items?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body.data;
    expect(r2.items).toEqual([{ rank: 1, menuItemId: BURGER, itemName: 'Chicken Burger', quantitySold: 2 }]);
  });

  it('404s top-items for an unknown outlet and rejects malformed windows', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/reports/outlets/${randomUUID()}/top-items?from=${WINDOW_FROM}&to=${WINDOW_TO}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    const badWindow = await request(app.getHttpServer())
      .get(`/api/v1/reports/revenue-by-outlet?from=${WINDOW_TO}&to=${WINDOW_FROM}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(badWindow.body.error.code).toBe('VALIDATION_FAILED');

    await request(app.getHttpServer())
      .get(`/api/v1/reports/revenue-by-outlet?from=2020-01-01T00:00:00Z&to=2021-06-01T00:00:00Z`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
