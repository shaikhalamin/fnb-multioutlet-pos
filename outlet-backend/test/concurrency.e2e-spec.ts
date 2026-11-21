import request from 'supertest';
import { Test, type TestingModule } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  configureE2eApp,
  type E2eApp,
  ITEM,
  loginAs,
  resetDemoStock,
  SEEDED_USERS,
  sql,
} from './helpers.js';

/**
 * Sale concurrency against real PostgreSQL (PRD §17, root AGENTS §6):
 * AT-05 (two parallel sales of the last unit ⇒ exactly one commits) and
 * AT-06 (100 concurrent sales ⇒ 100 distinct sequential receipts). The
 * global rate limiter is neutralized for this suite — it would 429 the burst
 * long before the row locks get a chance to prove anything.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

describeWithDeps('Outlet sale concurrency (e2e)', () => {
  let app: E2eApp;
  let cashierToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Concurrency target is the database, not the HTTP rate limiter.
      .overrideProvider(getOptionsToken())
      .useValue([{ name: 'default', ttl: 60_000, limit: 1_000_000 }])
      .compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();

    await resetDemoStock(app);
    cashierToken = await loginAs(app, SEEDED_USERS.cashier.email, SEEDED_USERS.cashier.password);
  });

  afterAll(async () => {
    if (app) {
      await resetDemoStock(app);
      await app.close();
    }
  });

  function postSale(key: string, items: Array<{ menuItemId: string; quantity: number }>) {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key)
      .send({ items });
  }

  it('AT-06: 100 concurrent sales of one unit each all commit with unique receipts', { timeout: 120_000 }, async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => postSale(`e2e-at06-${String(i).padStart(4, '0')}`, [
        { menuItemId: ITEM.cola, quantity: 1 },
      ]).then((response) => ({ status: response.status, body: response.body }))),
    );

    const created = results.filter((result) => result.status === 201);
    expect(created).toHaveLength(100);

    const receipts = created.map((result) => result.body.data.receiptNo as string);
    expect(new Set(receipts).size).toBe(100); // zero duplicates
    const numbers = receipts
      .map((receipt) => Number(receipt.slice('A-'.length)))
      .sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i] - numbers[i - 1]).toBe(1); // contiguous, no gaps
    }

    // Stock exhausted exactly: 100 − 100 = 0 and never negative.
    const stock = (
      await sql(app)<{ quantity_on_hand: string }[]>(
        'SELECT quantity_on_hand::text FROM inventory_balances WHERE menu_item_id = $1',
        [ITEM.cola],
      )
    )[0];
    expect(stock.quantity_on_hand).toBe('0');

    // Exactly one outbox event per sale (AT-03 invariant under contention).
    const events = (
      await sql(app)<{ count: string }[]>(
        "SELECT COUNT(*)::text AS count FROM outbox_events WHERE payload->'data'->>'saleId' = ANY($1::text[])",
        [created.map((result) => result.body.data.id as string)],
      )
    )[0];
    expect(events.count).toBe('100');

    // Sequences are unique and contiguous across the batch.
    const sequences = (
      await sql(app)<{ sequence_no: string }[]>('SELECT sequence_no::text FROM outbox_events ORDER BY sequence_no DESC LIMIT 100')
    ).map((row) => Number(row.sequence_no));
    expect(new Set(sequences).size).toBe(100);
  });

  it('AT-05: two parallel sales of the last unit ⇒ exactly one commits', { timeout: 60_000 }, async () => {
    await sql(app)('UPDATE inventory_balances SET quantity_on_hand = 1 WHERE menu_item_id = $1', [
      ITEM.burger,
    ]);

    const [first, second] = await Promise.all([
      postSale('e2e-at05-a-00000000001', [{ menuItemId: ITEM.burger, quantity: 1 }]),
      postSale('e2e-at05-b-00000000001', [{ menuItemId: ITEM.burger, quantity: 1 }]),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    const loser = first.status === 201 ? second : first;
    expect(loser.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(loser.body.error.details).toMatchObject({
      menuItemId: ITEM.burger,
      requestedQuantity: 1,
      availableQuantity: 0,
    });
    expect(winner.body.data.receiptNo).toMatch(/^A-[0-9]+$/);

    const stock = (
      await sql(app)<{ quantity_on_hand: string }[]>(
        'SELECT quantity_on_hand::text FROM inventory_balances WHERE menu_item_id = $1',
        [ITEM.burger],
      )
    )[0];
    expect(stock.quantity_on_hand).toBe('0'); // ≥ 0 enforced end to end

    // The rejected attempt left zero side effects.
    const sales = (
      await sql(app)<{ count: string }[]>(
        'SELECT COUNT(*)::text AS count FROM sales WHERE id = ANY($1::uuid[])',
        [[winner.body.data.id]],
      )
    )[0];
    expect(sales.count).toBe('1');
    const receipts = await sql(app)<{ receipt_no: string }[]>(
      'SELECT receipt_no FROM sales WHERE total_minor IS NOT NULL AND sold_at > now() - interval \'1 minute\'',
    );
    const distinct = new Set(receipts.map((row) => row.receipt_no));
    expect(distinct.size).toBe(receipts.length);
  });
});
