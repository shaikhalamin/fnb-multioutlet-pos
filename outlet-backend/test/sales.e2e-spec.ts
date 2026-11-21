import request from 'supertest';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  configureE2eApp,
  e2eKey,
  type E2eApp,
  ITEM,
  loginAs,
  resetDemoStock,
  SEEDED_USERS,
  sql,
} from './helpers.js';

/**
 * Sale semantics against real PostgreSQL + Redis (PRD §17): the AT-03 happy
 * path with SQL-level persistence checks, rollback on short lines (AT-04),
 * idempotent replay vs key reuse (AT-07/AT-08), offline-grace enforcement
 * (AT-11 partial), and persona permission denials (AT-17 flavor). Skipped
 * when the required environment is absent.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

const BURGER_PRICE = '1000';

describeWithDeps('Outlet sales (e2e)', () => {
  let app: E2eApp;
  let managerToken: string;
  let cashierToken: string;
  let clerkToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();

    await resetDemoStock(app);
    managerToken = await loginAs(app, SEEDED_USERS.manager.email, SEEDED_USERS.manager.password);
    cashierToken = await loginAs(app, SEEDED_USERS.cashier.email, SEEDED_USERS.cashier.password);
    clerkToken = await loginAs(app, SEEDED_USERS.clerk.email, SEEDED_USERS.clerk.password);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function saleCount(): Promise<string> {
    const rows = await sql(app)<{ count: string }[]>('SELECT COUNT(*)::text AS count FROM sales');
    return rows[0].count;
  }

  async function saleMovementCount(): Promise<string> {
    const rows = await sql(app)<{ count: string }[]>(
      "SELECT COUNT(*)::text AS count FROM stock_movements WHERE reason = 'SALE'",
    );
    return rows[0].count;
  }

  async function nextReceiptNumber(): Promise<string> {
    const rows = await sql(app)<{ next_number: string }[]>(
      'SELECT next_number::text FROM receipt_counters',
    );
    return rows[0].next_number;
  }

  async function stockOf(itemId: string): Promise<string> {
    const rows = await sql(app)<{ quantity_on_hand: string }[]>(
      'SELECT quantity_on_hand::text FROM inventory_balances WHERE menu_item_id = $1',
      [itemId],
    );
    return rows[0]?.quantity_on_hand ?? '0';
  }

  it('rejects a sale without the Idempotency-Key header with 400 VALIDATION_FAILED', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ items: [{ menuItemId: ITEM.burger, quantity: 1 }] })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects price/total/receipt/outletId fields in the body (whitelist pipe)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', e2eKey('whitelist'))
      .send({
        items: [{ menuItemId: ITEM.burger, quantity: 1 }],
        totalMinor: '1',
        outletId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  let saleId: string;
  let receiptNo: string;
  const KEY = e2eKey('at03');

  it('commits the AT-03 happy path atomically: 2 burgers + 1 pizza', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', KEY)
      .send({
        items: [
          { menuItemId: ITEM.burger, quantity: 2 },
          { menuItemId: ITEM.pizza, quantity: 1 },
        ],
      })
      .expect(201);

    const sale = response.body.data;
    saleId = sale.id;
    receiptNo = sale.receiptNo;
    expect(sale.receiptNo).toMatch(/^A-[0-9]{1,19}$/);
    expect(sale.status).toBe('COMPLETED');
    expect(sale.currencyCode).toBe('USD');
    expect(sale.totalMinor).toBe(String(2 * 1000 + 1500));
    expect(sale.items).toHaveLength(2);
    const burger = sale.items.find((item: { menuItemId: string }) => item.menuItemId === ITEM.burger);
    expect(burger.unitPriceMinor).toBe(BURGER_PRICE);
    expect(burger.subtotalMinor).toBe('2000');
    expect(burger.name).toBe('Chicken Burger');
    expect(sale.syncStatus).toBe('PENDING');
    // Envelope + request id everywhere (PRD §7).
    expect(response.body.meta.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBeTruthy();

    // Persistence layer (PRD §6.2): snapshots, movements, outbox, idempotency.
    const saleRow = (
      await sql(app)<Record<string, string>[]>('SELECT total_minor::text, currency_code, catalog_revision::text, status FROM sales WHERE id = $1', [saleId])
    )[0];
    expect(saleRow.total_minor).toBe('3500');
    expect(saleRow.catalog_revision).toBe('1');

    const items = await sql(app)<Record<string, string>[]>(
      'SELECT name_snapshot, sku_snapshot, quantity, unit_price_minor::text, subtotal_minor::text FROM sale_items WHERE sale_id = $1 ORDER BY sku_snapshot',
      [saleId],
    );
    expect(items).toHaveLength(2);
    expect(items.map((row) => row.sku_snapshot).join(',')).toBe('BURGER-01,PIZZA-01');

    const movements = await sql(app)<Record<string, string>[]>(
      'SELECT menu_item_id::text, delta_quantity::text FROM stock_movements WHERE source_sale_id = $1 ORDER BY menu_item_id',
      [saleId],
    );
    expect(movements).toEqual([
      { menu_item_id: ITEM.burger, delta_quantity: '-2' },
      { menu_item_id: ITEM.pizza, delta_quantity: '-1' },
    ]);

    const outbox = (
      await sql(app)<Record<string, string>[]>('SELECT status, payload_sha256, sequence_no::text FROM outbox_events WHERE id = $1', [
        (
          await sql(app)<{ id: string }[]>(
            "SELECT id FROM outbox_events WHERE payload->'data'->>'saleId' = $1",
            [saleId],
          )
        )[0].id,
      ])
    )[0];
    expect(outbox.status).toBe('PENDING');
    expect(outbox.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(outbox.sequence_no)).toBeGreaterThan(0);

    const idem = (
      await sql(app)<Record<string, unknown>[]>('SELECT request_sha256, response_json FROM sale_idempotency_keys WHERE key = $1', [KEY])
    )[0];
    expect(idem.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(idem.response_json).toMatchObject({ id: saleId, receiptNo: sale.receiptNo });

    // Stock decremented exactly once: 50−2 and 40−1.
    expect(await stockOf(ITEM.burger)).toBe('48');
    expect(await stockOf(ITEM.pizza)).toBe('39');
  });

  it('replays the stored response for the same key + body (AT-07): no second deduction or event', async () => {
    const salesBefore = await saleCount();
    const movementsBefore = await saleMovementCount();
    const receiptBefore = await nextReceiptNumber();

    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', KEY)
      .send({
        items: [
          { menuItemId: ITEM.burger, quantity: 2 },
          { menuItemId: ITEM.pizza, quantity: 1 },
        ],
      })
      .expect(201);

    expect(response.body.data.id).toBe(saleId);
    expect(response.body.data.receiptNo).toBe(receiptNo);
    expect(await saleCount()).toBe(salesBefore);
    expect(await saleMovementCount()).toBe(movementsBefore);
    expect(await nextReceiptNumber()).toBe(receiptBefore);
    expect(await stockOf(ITEM.burger)).toBe('48');
  });

  it('rejects the same key with a mutated body with 409 IDEMPOTENCY_KEY_REUSED (AT-08)', async () => {
    const salesBefore = await saleCount();
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', KEY)
      .send({
        items: [
          { menuItemId: ITEM.burger, quantity: 1 }, // mutated
          { menuItemId: ITEM.pizza, quantity: 1 },
        ],
      })
      .expect(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await saleCount()).toBe(salesBefore);
    // The original sale is unchanged.
    expect(await stockOf(ITEM.burger)).toBe('48');
  });

  it('rolls the entire transaction back when one line is short (AT-04)', async () => {
    const salesBefore = await saleCount();
    const movementsBefore = await saleMovementCount();
    const receiptBefore = await nextReceiptNumber();

    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', e2eKey('at04'))
      .send({
        items: [
          { menuItemId: ITEM.burger, quantity: 1 },
          { menuItemId: ITEM.cola, quantity: 100_000 }, // cola has 100
        ],
      })
      .expect(409);

    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(response.body.error.details).toMatchObject({
      menuItemId: ITEM.cola,
      requestedQuantity: 100_000,
      availableQuantity: 100,
    });

    // Zero side effects across every touched table.
    expect(await saleCount()).toBe(salesBefore);
    expect(await saleMovementCount()).toBe(movementsBefore);
    expect(await nextReceiptNumber()).toBe(receiptBefore);
    expect(await stockOf(ITEM.burger)).toBe('48'); // the first line was rolled back too
    expect(await stockOf(ITEM.cola)).toBe('100');
  });

  it('GET /sales/:id returns the receipt with snapshots and live sync status', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/sales/${saleId}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    const sale = response.body.data;
    expect(sale.id).toBe(saleId);
    expect(sale.receiptNo).toBe(receiptNo);
    expect(sale.syncStatus).toBe('PENDING');
    expect(sale.items.some((item: { sku: string }) => item.sku === 'BURGER-01')).toBe(true);
  });

  it('lists local sales history with keyset pagination meta', async () => {
    // A second sale so a limit=1 page actually has a successor.
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', e2eKey('list'))
      .send({ items: [{ menuItemId: ITEM.cola, quantity: 1 }] })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/api/v1/sales?limit=1')
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(typeof response.body.meta.nextCursor).toBe('string');

    // Date-filtered read excludes everything outside the window.
    const future = await request(app.getHttpServer())
      .get(`/api/v1/sales?from=${encodeURIComponent('2099-01-01T00:00:00.000Z')}`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .expect(200);
    expect(future.body.data).toHaveLength(0);
  });

  it('denies a cashier inventory adjustments and a clerk sales (AT-17 flavor)', async () => {
    const cashierDenied = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ menuItemId: ITEM.burger, deltaQuantity: 5, reason: 'RESTOCK' })
      .expect(403);
    expect(cashierDenied.body.error.code).toBe('FORBIDDEN');

    const clerkDenied = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${clerkToken}`)
        .set('Idempotency-Key', e2eKey('at17'))
      .send({ items: [{ menuItemId: ITEM.burger, quantity: 1 }] })
      .expect(403);
    expect(clerkDenied.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the clerk to restock through the audited adjustment endpoint', async () => {
    const before = Number(await stockOf(ITEM.burger));
    const response = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${clerkToken}`)
      .send({ menuItemId: ITEM.burger, deltaQuantity: 5, reason: 'RESTOCK' })
      .expect(200);
    expect(response.body.data.quantityOnHand).toBe(before + 5);
    expect(response.body.data.version).toBeGreaterThanOrEqual(2);

    const movement = (
      await sql(app)<Record<string, string>[]>(
        "SELECT reason, delta_quantity::text, request_id FROM stock_movements WHERE reason = 'RESTOCK' ORDER BY occurred_at DESC LIMIT 1",
      )
    )[0];
    expect(movement.reason).toBe('RESTOCK');
    expect(movement.delta_quantity).toBe('5');
    expect(movement.request_id).toBeTruthy(); // FR-04: request ID recorded
  });

  it('blocks sales with 503 SYNC_TEMPORARILY_UNAVAILABLE once the grace window lapses (AT-11)', async () => {
    await sql(app)(
      "UPDATE menu_sync_state SET last_sync_at = now() - interval '73 hours'",
    );
    try {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('Idempotency-Key', e2eKey('at11'))
        .send({ items: [{ menuItemId: ITEM.burger, quantity: 1 }] })
        .expect(503);
      expect(response.body.error.code).toBe('SYNC_TEMPORARILY_UNAVAILABLE');
      expect(response.body.error.details).toMatchObject({ offlineGraceHours: 72 });
      expect(response.body.error.details.lastMenuSyncAt).toBeTruthy();

      // Sync status reports the expired grace.
      const status = await request(app.getHttpServer())
        .get('/api/v1/sync/status')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(status.body.data.grace.expired).toBe(true);
      expect(status.body.data.outbox.pendingCount).toBeGreaterThan(0);
    } finally {
      await sql(app)('UPDATE menu_sync_state SET last_sync_at = now()');
    }
  });

  it('serves sync status from local tables only (no HQ dependency)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/sync/status')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const status = response.body.data;
    expect(status.outletId).toBe(process.env.OUTLET_ID);
    expect(status.outletCode).toBe('A');
    expect(status.lastAppliedRevision).toBe('1');
    expect(status.grace.expired).toBe(false);
    expect(status.outbox.pendingCount).toBeGreaterThan(0);
  });
});
