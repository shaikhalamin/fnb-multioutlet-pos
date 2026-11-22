import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../src/database/database.module.js';
import { HqSyncClient } from '../src/modules/sync/clients/hq-sync.client.js';
import { SyncDeliveryProcessor } from '../src/modules/sync/processors/sync-delivery.processor.js';
import { OutboxRepository } from '../src/modules/outbox/outbox.repository.js';
import { OutletAuditService } from '../src/modules/audit/outlet-audit.service.js';
import { configureE2eApp, loginAs, SEEDED_USERS, e2eKey, ensureDemoCatalog, type E2eApp } from './helpers.js';

/**
 * AT-10 (PRD §17): an outlet Redis outage must never block the sale path.
 * The API process keeps zero Redis/BullMQ dependencies — the entire app here
 * boots with an unreachable REDIS_URL (dead port, verified), a POS sale still
 * commits with its outbox row in the same transaction, and the backlog then
 * drains through the same durable sweep→deliver path the workers drive once
 * scheduling recovers. If any future change ever wires Redis into the sale
 * path, this spec is the tripwire.
 */
const hasDependencies =
  Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL?.includes('vitest');
const describeWithDeps = hasDependencies ? describe : describe.skip;

/** A port nothing listens on — the app runs with this as its Redis. */
const DEAD_REDIS_PORT = 1;
const DEAD_REDIS_URL = `redis://127.0.0.1:${DEAD_REDIS_PORT}/0`;

/** Resolves while the endpoint is unreachable; rejects if something answers. */
function assertUnreachable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(2_000);
    socket.once('error', () => resolve()); // ECONNREFUSED — genuinely down
    socket.once('timeout', () => resolve()); // filtered — equally down
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`${host}:${port} unexpectedly answered — Redis is not down`));
    });
  });
}

describeWithDeps('AT-10: outlet Redis outage never blocks sales (e2e)', () => {
  let app: E2eApp;
  let dataSource: DataSource;
  let outbox: OutboxRepository;
  const originalRedisUrl = process.env.REDIS_URL;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    // Pin the dead Redis BEFORE the module graph is imported: AppModule
    // evaluation runs ConfigModule validation, and every later ConfigService
    // read must see the unreachable URL (same ordering contract as
    // worker-main.ts).
    process.env.REDIS_URL = DEAD_REDIS_URL;
    const { AppModule } = await import('../src/app.module.js');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();
    dataSource = app.get<DataSource>(DATA_SOURCE);
    outbox = new OutboxRepository(dataSource);

    await ensureDemoCatalog(app);
    // Keep the grace window healthy so a 503 here could only ever come from
    // the outage under test, not from a stale checkpoint.
    await dataSource.query('UPDATE menu_sync_state SET last_sync_at = now(), grace_overridden_until = NULL');
  });

  afterAll(async () => {
    if (createdEventIds.length > 0 && dataSource) {
      await dataSource.query('DELETE FROM sync_attempt_logs WHERE outbox_event_id = ANY($1::uuid[])', [createdEventIds]);
      await dataSource.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [createdEventIds]);
    }
    if (originalRedisUrl !== undefined) {
      process.env.REDIS_URL = originalRedisUrl;
    }
    if (app) await app.close();
  });

  it('commits a sale with its outbox row while Redis is provably down', async () => {
    await assertUnreachable(DEAD_REDIS_PORT, '127.0.0.1');

    const cashierToken = await loginAs(app, SEEDED_USERS.cashier.email, SEEDED_USERS.cashier.password);
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', e2eKey('at10-redis-down'))
      .send({ items: [{ menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab', quantity: 1 }] })
      .expect(201)
      .expect((res) => expect(res.body.data.status).toBe('COMPLETED'));

    const saleId = response.body.data.id as string;
    createdEventIds.push(
      ...(
        await dataSource.query<Array<{ id: string }>>(
          'SELECT id FROM outbox_events WHERE payload->\'data\'->>\'saleId\' = $1',
          [saleId],
        )
      ).map((row) => row.id),
    );

    // The committed sale carries exactly one PENDING outbox row — same
    // transaction, no queue involvement (§8.4, AT-10).
    const outboxRows = await dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM outbox_events WHERE payload->\'data\'->>\'saleId\' = $1',
      [saleId],
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe('PENDING');
  });

  it('drains the backlog through the durable sweep→deliver path once scheduling returns', async () => {
    expect(createdEventIds.length).toBeGreaterThanOrEqual(1);
    const statusRows = () =>
      dataSource.query<Array<{ id: string; status: string }>>(
        'SELECT id::text AS id, status FROM outbox_events WHERE id = ANY($1::uuid[])',
        [createdEventIds],
      );

    // Under the live compose worker the real sweeper drains rows
    // concurrently (HQ dedupes any double push to DUPLICATE) — so this loop
    // converges rather than demanding exactly one delivery: whatever is
    // still undelivered drains here through the exact durable path the
    // BullMQ workers drive after recovery: reload rows by event ID, push,
    // mark DELIVERED on ack. Redis only ever scheduled this work.
    const { server, url } = await startStubHq((events) => ({
      batchId: 'stub',
      results: events.map((event) => ({
        eventId: event.eventId,
        status: 'ACCEPTED',
        retryable: false,
        acknowledgedAt: new Date().toISOString(),
      })),
      highestContiguousSequence: '0',
    }));
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const pending = (await statusRows())
          .filter((row) => row.status === 'PENDING' || row.status === 'RETRY')
          .map((row) => row.id);
        if (pending.length === 0) break;
        const processor = makeDeliveryProcessor(dataSource, outbox, url);
        await processor.deliver(pending);
        if (Date.now() > deadline) {
          throw new Error(`AT-10 backlog did not drain: ${pending.join(', ')}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const after = await statusRows();
    expect(after).toHaveLength(createdEventIds.length);
    expect(after.every((row) => row.status === 'DELIVERED')).toBe(true);
  }, 25_000);
});

/** Stub HQ accepting every event (mirrors sync-dispatch.e2e-spec.ts). */
async function startStubHq(
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: results(parsed.events), meta: { requestId: randomUUID(), timestamp: new Date().toISOString() } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}/api/v1` };
}

function makeDeliveryProcessor(
  dataSource: DataSource,
  outbox: OutboxRepository,
  baseUrl: string,
): SyncDeliveryProcessor {
  const credentials = {
    hqApiBaseUrl: baseUrl,
    keyId: 'e2e-key-id',
    keySecret: 'e2e-key-secret',
  };
  const provider = {
    refresh: async () => credentials,
    get: () => credentials,
  };
  const config = {
    get: (key: string) => (key === 'OUTBOX_BATCH_SIZE' ? 100 : undefined),
  };
  const client = new HqSyncClient(provider as never);
  return new SyncDeliveryProcessor(
    outbox,
    client,
    new OutletAuditService(dataSource),
    config as unknown as ConfigService<never, true>,
  );
}
