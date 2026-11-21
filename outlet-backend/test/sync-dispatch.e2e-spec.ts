import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DATA_SOURCE } from '../src/database/database.module.js';
import type { ConfigService } from '@nestjs/config';
import { HqSyncClient } from '../src/modules/sync/clients/hq-sync.client.js';
import { SyncDeliveryProcessor } from '../src/modules/sync/processors/sync-delivery.processor.js';
import { OutboxRepository } from '../src/modules/outbox/outbox.repository.js';
import { OutletAuditService } from '../src/modules/audit/outlet-audit.service.js';
import { configureE2eApp, loginAs, SEEDED_USERS, e2eKey, type E2eApp } from './helpers.js';

/**
 * Phase-3 sync dispatch against real PostgreSQL (PRD §17): lease exclusivity
 * and expiry recovery (§8.6 A/G), delivery against a stubbed HQ asserting
 * the OutletKey header and per-event ack handling (§8.5), and the audited
 * emergency-grace flow (§8.8, AT-11/AT-17 flavors).
 */
const hasDependencies =
  Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL?.includes('vitest');
const describeWithDeps = hasDependencies ? describe : describe.skip;

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';

/** Inserts a well-formed PENDING outbox row; returns its id (= eventId). */
async function insertOutboxRow(dataSource: DataSource, sequenceNo: string): Promise<string> {
  const eventId = randomUUID();
  const payload = {
    eventId,
    eventType: 'sale.completed',
    schemaVersion: 1,
    outletId: OUTLET_ID,
    sequenceNo,
    occurredAt: new Date().toISOString(),
    data: {
      saleId: randomUUID(),
      receiptNo: `E2E-${sequenceNo}`,
      catalogRevision: '1',
      currencyCode: 'USD',
      status: 'COMPLETED',
      soldAt: new Date().toISOString(),
      totalMinor: '1200',
      items: [
        {
          saleItemId: randomUUID(),
          menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
          nameSnapshot: 'Chicken Burger',
          skuSnapshot: 'BURGER-01',
          quantity: 1,
          unitPriceMinor: '1200',
          subtotalMinor: '1200',
        },
      ],
    },
  };
  await dataSource.query(
    `INSERT INTO outbox_events (id, outlet_id, sequence_no, event_type, schema_version, payload, payload_sha256, status, attempts)
     VALUES ($1, $2, $3, 'sale.completed', 1, $4::jsonb, $5, 'PENDING', 0)`,
    [eventId, OUTLET_ID, sequenceNo, JSON.stringify(payload), randomUUID().replace(/-/g, '')],
  );
  return eventId;
}

describeWithDeps('Outlet sync dispatch (e2e)', () => {
  let app: E2eApp;
  let appDataSource: DataSource;
  let standalone: DataSource;
  let outbox: OutboxRepository;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
    appDataSource = app.get<DataSource>(DATA_SOURCE);
    standalone = appDataSource; // share the app's pool for direct fixtures

    outbox = new OutboxRepository(appDataSource);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const seqBase = BigInt(Date.now()) * 10n;
  const createdIds: string[] = [];

  // ---- §8.6 A/G: leasing + expiry ---------------------------------------------

  /** Leases every currently-eligible row so the spec starts from a clean slate. */
  async function drainEligible(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      const leased = await outbox.leaseDueBatch(500, 300_000);
      if (leased.length === 0) return;
    }
    throw new Error('outbox drain did not converge');
  }

  it('never leases the same row to two concurrent sweepers (SKIP LOCKED)', async () => {
    await drainEligible(); // leftover PENDING rows from earlier runs park aside
    const a = await insertOutboxRow(standalone, (seqBase + 1n).toString());
    const b = await insertOutboxRow(standalone, (seqBase + 2n).toString());
    createdIds.push(a, b);

    const [first, second] = await Promise.all([
      outbox.leaseDueBatch(2, 60_000),
      outbox.leaseDueBatch(2, 60_000),
    ]);
    const ids = [...first, ...second].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length); // exclusivity under contention
    expect(ids.sort()).toEqual([a, b].sort());
    expect(first.every((row) => row.leaseUntil !== null)).toBe(true);
    expect(first.every((row) => row.attempts >= 1)).toBe(true);
  });

  it('returns stalled leases to eligible and the scanner recovers them (§8.6 G)', async () => {
    const mine = [...createdIds];
    expect(mine.length).toBeGreaterThanOrEqual(2);
    // Backdate only this spec's leases; the sweeper path must reclaim them.
    await standalone.query("UPDATE outbox_events SET lease_until = now() - interval '1 second' WHERE id = ANY($1::uuid[])", [mine]);
    const expired = await outbox.expireLeases();
    expect(expired).toBeGreaterThanOrEqual(mine.length);

    const reclaimed = await outbox.leaseDueBatch(100, 60_000);
    const reclaimedIds = reclaimed.map((row) => row.id);
    for (const id of mine) {
      expect(reclaimedIds).toContain(id);
    }
  });

  // ---- §8.5: delivery against a stubbed HQ ------------------------------------

  it('pushes leased rows to HQ with the machine key and marks DELIVERED only on ACCEPTED', async () => {
    const eventId = await insertOutboxRow(standalone, (seqBase + 101n).toString());
    createdIds.push(eventId);

    const seen: Array<{ authorization?: string; idempotencyKey?: string; events: unknown[] }> = [];
    const server = await startStubHq(seen, (events) => ({
      batchId: 'stub',
      results: events.map((event) => ({ eventId: (event as { eventId: string }).eventId, status: 'ACCEPTED', retryable: false, acknowledgedAt: new Date().toISOString() })),
      highestContiguousSequence: (seqBase + 101n).toString(),
    }));
    try {
      const processor = makeDeliveryProcessor(server.url);
      const outcome = await processor.deliver([eventId]);
      expect(outcome).toMatchObject({ delivered: 1, retried: 0, quarantined: 0 });

      expect(seen).toHaveLength(1);
      expect(seen[0].authorization).toBe('OutletKey e2e-key-id.e2e-key-secret');
      expect(seen[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/); // one stable key per attempt

      const row = await standalone.query<Array<{ status: string }>>('SELECT status FROM outbox_events WHERE id = $1', [eventId]);
      expect(row[0].status).toBe('DELIVERED');
      const attempts = await standalone.query<Array<{ count: number }>>(
        'SELECT COUNT(*)::int AS count FROM sync_attempt_logs WHERE outbox_event_id = $1',
        [eventId],
      );
      expect(attempts[0].count).toBe(1);
    } finally {
      await closeServer(server.server);
    }
  });

  it('quarantines REJECTED_PERMANENT rows with an audit alert, never deleting them', async () => {
    const eventId = await insertOutboxRow(standalone, (seqBase + 201n).toString());
    createdIds.push(eventId);

    const server = await startStubHq([], (events) => ({
      batchId: 'stub',
      results: events.map((event) => ({
        eventId: (event as { eventId: string }).eventId,
        status: 'REJECTED_PERMANENT',
        retryable: false,
        detail: 'EVENT_ID_CONFLICT',
      })),
      highestContiguousSequence: '0',
    }));
    try {
      const processor = makeDeliveryProcessor(server.url);
      const outcome = await processor.deliver([eventId]);
      expect(outcome).toMatchObject({ quarantined: 1, delivered: 0 });

      const row = await standalone.query<Array<{ status: string; last_error: string }>>(
        'SELECT status, last_error FROM outbox_events WHERE id = $1',
        [eventId],
      );
      expect(row[0]).toMatchObject({ status: 'QUARANTINED', last_error: 'EVENT_ID_CONFLICT' });
      const audit = await standalone.query<Array<{ count: number }>>(
        "SELECT COUNT(*)::int AS count FROM outlet_audit_logs WHERE action = 'sync.event_quarantined' AND entity_id = $1",
        [eventId],
      );
      expect(audit[0].count).toBe(1);

      // Manual replay re-arms the row (§8.5) — exercised at the repository
      // level, on a transaction manager as the service does.
      const replayed = await appDataSource.transaction((manager) => outbox.replayQuarantined(manager, eventId));
      expect(replayed).toBe(true);
    } finally {
      await closeServer(server.server);
    }
  });

  // ---- §8.8: audited emergency grace override (AT-11/AT-17 legs) ---------------

  it('grace flow: stale sync blocks sales → manager override rescues → audited', async () => {
    const managerToken = await loginAs(app, SEEDED_USERS.manager.email, SEEDED_USERS.manager.password);
    const cashierToken = await loginAs(app, SEEDED_USERS.cashier.email, SEEDED_USERS.cashier.password);

    const restore = async (): Promise<void> => {
      await appDataSource.query(
        'UPDATE menu_sync_state SET last_sync_at = now(), grace_overridden_until = NULL',
      );
    };

    try {
      // Backdate the checkpoint past the 72h window: sales must 503.
      await appDataSource.query("UPDATE menu_sync_state SET last_sync_at = now() - interval '73 hours', grace_overridden_until = NULL");
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('Idempotency-Key', e2eKey('grace-blocked'))
        .send({ items: [{ menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab', quantity: 1 }] })
        .expect(503)
        .expect((res) => expect(res.body.error.code).toBe('SYNC_TEMPORARILY_UNAVAILABLE'));

      // The cashier cannot apply the override (AT-17 flavor).
      await request(app.getHttpServer())
        .post('/api/v1/sync/grace-override')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ hours: 2, reason: 'should be forbidden for cashiers' })
        .expect(403)
        .expect((res) => expect(res.body.error.code).toBe('FORBIDDEN'));

      // Manager override rescues the sale and is audited.
      await request(app.getHttpServer())
        .post('/api/v1/sync/grace-override')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ hours: 4, reason: 'Regional network outage; connector replacement scheduled.' })
        .expect(200)
        .expect((res) => expect(res.body.data.until).toBeTruthy());

      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${cashierToken}`)
        .set('Idempotency-Key', e2eKey('grace-rescued'))
        .send({ items: [{ menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab', quantity: 1 }] })
        .expect(201)
        .expect((res) => expect(res.body.data.status).toBe('COMPLETED'));

      const audit = await appDataSource.query<Array<{ count: number }>>(
        "SELECT COUNT(*)::int AS count FROM outlet_audit_logs WHERE action = 'sync.grace_override'",
      );
      expect(audit[0].count).toBeGreaterThanOrEqual(1);

      // The status read surfaces the active override.
      const status = await request(app.getHttpServer())
        .get('/api/v1/sync/status')
        .set('Authorization', `Bearer ${managerToken}`)
        .expect(200);
      expect(status.body.data.grace.override).toMatchObject({ active: true });
      expect(status.body.data.grace.expired).toBe(false);
    } finally {
      await restore();
    }
  });

  afterAll(async () => {
    if (!standalone || createdIds.length === 0) return;
    await standalone.query('DELETE FROM sync_attempt_logs WHERE outbox_event_id = ANY($1::uuid[])', [createdIds]);
    await standalone.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [createdIds]);
  });

  // ---- helpers ------------------------------------------------------------------

  function makeDeliveryProcessor(baseUrl: string): SyncDeliveryProcessor {
    const config = {
      get: (key: string) =>
        key === 'OUTBOX_BATCH_SIZE'
          ? 100
          : key === 'HQ_API_BASE_URL'
            ? baseUrl
            : key === 'HQ_OUTLET_KEY_ID'
              ? 'e2e-key-id'
              : key === 'HQ_OUTLET_KEY_SECRET'
                ? 'e2e-key-secret'
                : undefined,
    };
    const client = new HqSyncClient(config as unknown as ConfigService<never, true>);
    return new SyncDeliveryProcessor(
      outbox,
      client,
      new OutletAuditService(appDataSource),
      config as unknown as ConfigService<never, true>,
    );
  }
});

/** Minimal HQ stub answering `POST /api/v1/sync/v1/events/batch`. */
async function startStubHq(
  seen: Array<{ authorization?: string; idempotencyKey?: string; events: unknown[] }>,
  results: (events: Array<{ eventId: string }>) => unknown,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/sync/v1/events/batch')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { events: Array<{ eventId: string }> };
      seen.push({
        authorization: req.headers.authorization,
        idempotencyKey: req.headers['idempotency-key'],
        events: parsed.events,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: results(parsed.events), meta: { requestId: 'stub', timestamp: new Date().toISOString() } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}/api/v1` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
