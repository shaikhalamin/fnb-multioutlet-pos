import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { OutboxEventEntity } from '../../../database/entities/outbox-event.entity.js';
import type { OutletAuditService } from '../../audit/outlet-audit.service.js';
import type { OutboxRepository } from '../../outbox/outbox.repository.js';
import type { HqSyncClient } from '../clients/hq-sync.client.js';
import { HqSyncError } from '../clients/hq-sync.client.js';
import { OutboxSweepProcessor } from './outbox-sweep.processor.js';
import { SyncDeliveryProcessor } from './sync-delivery.processor.js';

const OUTLET = '11111111-1111-4111-8111-111111111111';

let counter = 0;
function eventRow(overrides: Partial<OutboxEventEntity> = {}): OutboxEventEntity {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  return {
    id,
    outletId: OUTLET,
    sequenceNo: String(counter),
    eventType: 'sale.completed',
    schemaVersion: 1,
    // Real outbox rows guarantee payload.eventId === row id (PRD §8.4).
    payload: { eventId: id, data: { n: counter } },
    payloadSha256: 'hash',
    status: 'PENDING',
    attempts: 1,
    nextAttemptAt: null,
    leaseUntil: new Date(),
    publishedAt: null,
    lastError: null,
    createdAt: new Date(),
    ...overrides,
  } as OutboxEventEntity;
}

function makeDelivery(
  hqPush: (events: unknown[], key: string) => Promise<{ results: Array<{ eventId: string; status: string; detail?: string | null }> }>,
  batchSize = 100,
) {
  const outbox = {
    findByIds: vi.fn(async (ids: string[]) => ids.map(() => eventRow())),
    markDelivered: vi.fn(async () => undefined),
    markRetry: vi.fn(async () => undefined),
    markQuarantined: vi.fn(async () => undefined),
    appendAttemptLog: vi.fn(async () => undefined),
  };
  const hq = { pushEventBatch: vi.fn(hqPush) };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { get: (key: string) => (key === 'OUTBOX_BATCH_SIZE' ? batchSize : undefined) };
  const processor = new SyncDeliveryProcessor(
    outbox as unknown as OutboxRepository,
    hq as unknown as HqSyncClient,
    audit as unknown as OutletAuditService,
    config as unknown as ConfigService<never, true>,
  );
  return { processor, outbox, hq, audit };
}

describe('SyncDeliveryProcessor', () => {
  it('marks events DELIVERED only after an HQ ACCEPTED or DUPLICATE ack (§8.6 D)', async () => {
    const rows = [eventRow(), eventRow()];
    const { processor, outbox } = makeDelivery(async (events) => ({
      results: [
        { eventId: (events[0] as { eventId: string }).eventId, status: 'ACCEPTED' },
        { eventId: (events[1] as { eventId: string }).eventId, status: 'DUPLICATE' },
      ],
    }));
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver(rows.map((row) => row.id));
    expect(outcome).toEqual({ delivered: 2, retried: 0, quarantined: 0 });
    expect(outbox.markDelivered).toHaveBeenCalledWith(rows.map((row) => row.id), expect.any(Date));
    expect(outbox.markRetry).not.toHaveBeenCalled();
  });

  it('retries per-event RETRYABLE_ERROR outcomes with backoff', async () => {
    const rows = [eventRow({ attempts: 2 })];
    const { processor, outbox } = makeDelivery(async (events) => ({
      results: [{ eventId: (events[0] as { eventId: string }).eventId, status: 'RETRYABLE_ERROR', detail: 'TRANSACTION_FAILED' }],
    }));
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver([rows[0].id]);
    expect(outcome.retried).toBe(1);
    expect(outbox.markRetry).toHaveBeenCalledWith(
      [rows[0].id],
      'TRANSACTION_FAILED',
      expect.any(Number),
      expect.any(Date),
    );
  });

  it('quarantines REJECTED_PERMANENT events and alerts the operator (§8.6 F)', async () => {
    const rows = [eventRow()];
    const { processor, outbox, audit } = makeDelivery(async (events) => ({
      results: [{ eventId: (events[0] as { eventId: string }).eventId, status: 'REJECTED_PERMANENT', detail: 'EVENT_ID_CONFLICT' }],
    }));
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver([rows[0].id]);
    expect(outcome.quarantined).toBe(1);
    expect(outbox.markQuarantined).toHaveBeenCalledWith(rows[0].id, 'EVENT_ID_CONFLICT');
    expect(outbox.markDelivered).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sync.event_quarantined', entityId: rows[0].id }),
    );
  });

  it('retries events HQ answered 200 for but did not acknowledge', async () => {
    const rows = [eventRow(), eventRow()];
    const { processor, outbox } = makeDelivery(async (events) => ({
      results: [{ eventId: (events[1] as { eventId: string }).eventId, status: 'ACCEPTED' }],
    }));
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver(rows.map((row) => row.id));
    expect(outcome.delivered).toBe(1);
    expect(outcome.retried).toBe(1);
    expect(outbox.markRetry).toHaveBeenCalledWith([rows[0].id], 'HQ_ACK_MISSING', expect.any(Number), expect.any(Date));
  });

  it('retries the whole batch on 5xx with Retry-After honored', async () => {
    const rows = [eventRow({ attempts: 1 })];
    const { processor, outbox } = makeDelivery(async () => {
      throw new HqSyncError('service unavailable', 503, 'HTTP_503', 30);
    });
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver([rows[0].id]);
    expect(outcome.retried).toBe(1);
    const [ids, error, delay] = outbox.markRetry.mock.calls[0];
    expect(ids).toEqual([rows[0].id]);
    expect(error).toContain('service unavailable');
    // Retry-After is a floor honored exactly: 30s means 30s, no jitter shave.
    expect(delay).toBe(30_000);
    expect(outbox.markQuarantined).not.toHaveBeenCalled();
  });

  it('quarantines on non-retryable batch faults (401) instead of infinite retries (§8.7)', async () => {
    const rows = [eventRow()];
    const { processor, outbox, audit } = makeDelivery(async () => {
      throw new HqSyncError('Outlet key verification failed.', 401, 'UNAUTHENTICATED', null);
    });
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver([rows[0].id]);
    expect(outcome.quarantined).toBe(1);
    expect(outbox.markQuarantined).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'sync.batch_quarantined' }));
  });

  it('splits a backlog into batches bounded by OUTBOX_BATCH_SIZE (§8.5)', async () => {
    const rows = [eventRow(), eventRow(), eventRow()];
    const { processor, outbox, hq } = makeDelivery(async (events) => ({
      results: (events as Array<{ eventId: string }>).map((event) => ({ eventId: event.eventId, status: 'ACCEPTED' })),
    }), 2);
    outbox.findByIds.mockResolvedValue(rows);

    await processor.deliver(rows.map((row) => row.id));
    expect(hq.pushEventBatch).toHaveBeenCalledTimes(2);
    expect(hq.pushEventBatch.mock.calls[0][0]).toHaveLength(2);
    expect(hq.pushEventBatch.mock.calls[1][0]).toHaveLength(1);
    // Each batch attempt carries its own idempotency key.
    expect(hq.pushEventBatch.mock.calls[0][1]).not.toBe(hq.pushEventBatch.mock.calls[1][1]);
  });

  it('skips rows that are no longer eligible (already delivered/quarantined)', async () => {
    const { processor, outbox, hq } = makeDelivery(async () => ({ results: [] }));
    outbox.findByIds.mockResolvedValue([eventRow({ status: 'DELIVERED' }), eventRow({ status: 'QUARANTINED' })]);

    const outcome = await processor.deliver(['a', 'b']);
    expect(outcome).toEqual({ delivered: 0, retried: 0, quarantined: 0 });
    expect(hq.pushEventBatch).not.toHaveBeenCalled();
  });

  it('reuses the same Idempotency-Key across job retries of the same rows (§8.5)', async () => {
    const rows = [eventRow(), eventRow()];
    const { processor, outbox, hq } = makeDelivery(async (events) => ({
      results: (events as Array<{ eventId: string }>).map((event) => ({ eventId: event.eventId, status: 'ACCEPTED' })),
    }));
    // Rows still eligible on the second deliver() — e.g. a BullMQ job retry
    // racing the outcome write, or a reconciliation re-lease.
    outbox.findByIds.mockResolvedValue(rows.map((row) => ({ ...row, status: 'RETRY', nextAttemptAt: null })));

    await processor.deliver(rows.map((row) => row.id));
    await processor.deliver(rows.map((row) => row.id));
    expect(hq.pushEventBatch).toHaveBeenCalledTimes(2);
    expect(hq.pushEventBatch.mock.calls[1][1]).toBe(hq.pushEventBatch.mock.calls[0][1]);
  });

  it('leaves rows whose computed backoff has not elapsed to the sweeper', async () => {
    const rows = [eventRow({ status: 'RETRY', nextAttemptAt: new Date(Date.now() + 60_000) })];
    const { processor, outbox, hq } = makeDelivery(async () => ({ results: [] }));
    outbox.findByIds.mockResolvedValue(rows);

    const outcome = await processor.deliver(rows.map((row) => row.id));
    expect(outcome).toEqual({ delivered: 0, retried: 0, quarantined: 0 });
    expect(hq.pushEventBatch).not.toHaveBeenCalled();
  });
});

describe('OutboxSweepProcessor', () => {
  it('expires stalled leases before leasing the next batch (§8.6 G recovery)', async () => {
    const order: string[] = [];
    const outbox = {
      expireLeases: vi.fn(async () => {
        order.push('expire');
        return 1;
      }),
      leaseDueBatch: vi.fn(async () => {
        order.push('lease');
        return [eventRow()];
      }),
    };
    const config = { get: (key: string) => (key === 'OUTBOX_BATCH_SIZE' ? 100 : key === 'OUTBOX_SWEEP_INTERVAL_MS' ? 5_000 : undefined) };
    const sweeper = new OutboxSweepProcessor(
      outbox as unknown as OutboxRepository,
      config as unknown as ConfigService<never, true>,
    );

    const ids = await sweeper.sweep();
    expect(order).toEqual(['expire', 'lease']);
    expect(ids).toHaveLength(1);
  });
});
