import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service.js';
import { sha256OfCanonicalJson } from '../../common/utils/canonical-json.js';
import type { SyncEventV1 } from './dto/event-batch.dto.js';
import { EventIngestService, saleInvariantError } from './event-ingest.service.js';
import type { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import type { SyncInboxRepository } from './sync-inbox.repository.js';

const OUTLET_A = '11111111-1111-4111-8111-111111111111';
const OUTLET_B = '22222222-2222-4222-8222-222222222222';

let eventCounter = 0;

/** A structurally valid v1 sale.completed event with distinct UUIDs. */
function makeEvent(overrides: Record<string, unknown> = {}): SyncEventV1 {
  eventCounter += 1;
  const n = eventCounter;
  return {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    eventType: 'sale.completed',
    schemaVersion: 1,
    outletId: OUTLET_A,
    sequenceNo: String(n),
    occurredAt: '2026-11-20T04:02:03.000Z',
    data: {
      saleId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      receiptNo: `A-${String(n).padStart(6, '0')}`,
      catalogRevision: '42',
      currencyCode: 'USD',
      status: 'COMPLETED',
      soldAt: '2026-11-20T04:02:03.000Z',
      totalMinor: '2400',
      items: [
        {
          saleItemId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
          nameSnapshot: 'Chicken Burger',
          skuSnapshot: 'BURGER-01',
          quantity: 2,
          unitPriceMinor: '1200',
          subtotalMinor: '2400',
        },
      ],
    },
    ...overrides,
  } as unknown as SyncEventV1;
}

function makeService(
  inboxOverrides: Partial<Record<string, unknown>> = {},
  checkpointOverrides: Partial<Record<string, unknown>> = {},
  transactionImpl?: (cb: (manager: unknown) => Promise<unknown>) => Promise<unknown>,
) {
  const inbox = {
    findInboxEvent: vi.fn().mockResolvedValue(null),
    findInboxEventBySequence: vi.fn().mockResolvedValue(null),
    insertAcceptedEvent: vi.fn().mockResolvedValue(undefined),
    ...inboxOverrides,
  };
  const checkpoints = {
    find: vi.fn().mockResolvedValue({ highestContiguousSequence: '5' }),
    lockCheckpointRow: vi.fn().mockResolvedValue(undefined),
    advanceContiguous: vi.fn().mockResolvedValue('5'),
    ...checkpointOverrides,
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const dataSource = {
    transaction: vi.fn(
      transactionImpl ?? ((cb: (manager: unknown) => Promise<unknown>) => cb({})),
    ),
  };
  const service = new EventIngestService(
    dataSource as unknown as DataSource,
    inbox as unknown as SyncInboxRepository,
    checkpoints as unknown as SyncCheckpointRepository,
    audit as unknown as AuditService,
  );
  return { service, inbox, checkpoints, audit, dataSource };
}

describe('EventIngestService.ingestBatch', () => {
  it('accepts a valid event: inbox + projection + checkpoint in one transaction', async () => {
    const event = makeEvent();
    const { service, inbox, checkpoints } = makeService();
    const response = await service.ingestBatch({ batchId: 'b1', events: [event] }, OUTLET_A);

    expect(response.results[0]).toMatchObject({ eventId: event.eventId, status: 'ACCEPTED', retryable: false });
    expect(response.results[0].acknowledgedAt).toBeTruthy();
    expect(response.highestContiguousSequence).toBe('5');
    expect(inbox.insertAcceptedEvent).toHaveBeenCalledWith(
      expect.anything(),
      event,
      sha256OfCanonicalJson(event),
    );
    expect(checkpoints.lockCheckpointRow).toHaveBeenCalled();
    expect(checkpoints.advanceContiguous).toHaveBeenCalled();
  });

  it('rejects the ENTIRE request when any event claims another outlet (AT-16)', async () => {
    const { service, inbox } = makeService();
    await expect(
      service.ingestBatch({ batchId: 'b1', events: [makeEvent(), makeEvent({ outletId: OUTLET_B })] }, OUTLET_A),
    ).rejects.toMatchObject({ status: 403, response: { code: 'FORBIDDEN' } });
    expect(inbox.insertAcceptedEvent).not.toHaveBeenCalled();
  });

  it('returns DUPLICATE (terminal success) for byte-identical redelivery (AT-09)', async () => {
    const event = makeEvent();
    const { service, inbox } = makeService({
      findInboxEvent: vi.fn().mockResolvedValue({
        eventId: event.eventId,
        sequenceNo: event.sequenceNo,
        payloadSha256: sha256OfCanonicalJson(event),
      }),
    });
    const response = await service.ingestBatch({ batchId: 'b1', events: [event] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE', retryable: false });
    expect(response.results[0].acknowledgedAt).toBeTruthy();
    expect(inbox.insertAcceptedEvent).not.toHaveBeenCalled();
  });

  it('returns REJECTED_PERMANENT + audit alert when an eventId is reused with a different payload (AT-15)', async () => {
    const event = makeEvent();
    const { service, inbox, audit } = makeService({
      findInboxEvent: vi.fn().mockResolvedValue({
        eventId: event.eventId,
        sequenceNo: event.sequenceNo,
        payloadSha256: 'different-hash',
      }),
    });
    const response = await service.ingestBatch({ batchId: 'b1', events: [event] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({
      status: 'REJECTED_PERMANENT',
      detail: 'EVENT_ID_CONFLICT',
      retryable: false,
    });
    expect(inbox.insertAcceptedEvent).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sync.event_id_conflict' }),
      expect.anything(),
    );
  });

  it('returns REJECTED_PERMANENT when a different event already owns the sequenceNo', async () => {
    const event = makeEvent({ sequenceNo: '9' });
    const { service, audit } = makeService({
      findInboxEventBySequence: vi.fn().mockResolvedValue({
        eventId: '99999999-9999-4999-8999-999999999999',
        sequenceNo: '9',
        payloadSha256: 'hash',
      }),
    });
    const response = await service.ingestBatch({ batchId: 'b1', events: [event] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({ status: 'REJECTED_PERMANENT', detail: 'EVENT_ID_CONFLICT' });
    expect(audit.record).toHaveBeenCalled();
  });

  it('returns REJECTED_PERMANENT with UNSUPPORTED_EVENT_VERSION for unknown versions', async () => {
    const { service } = makeService();
    const response = await service.ingestBatch(
      { batchId: 'b1', events: [makeEvent({ schemaVersion: 99 })] },
      OUTLET_A,
    );
    expect(response.results[0]).toMatchObject({
      status: 'REJECTED_PERMANENT',
      detail: 'UNSUPPORTED_EVENT_VERSION',
    });
  });

  it('returns REJECTED_PERMANENT when integrity invariants fail (bigint math)', async () => {
    const { service } = makeService();
    const badLine = makeEvent();
    (badLine.data.items[0] as { subtotalMinor: string }).subtotalMinor = '9999';
    const response = await service.ingestBatch({ batchId: 'b1', events: [badLine] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({
      status: 'REJECTED_PERMANENT',
      detail: 'INVARIANT_LINE_SUBTOTAL',
    });
  });

  it('returns RETRYABLE_ERROR when the per-event transaction fails', async () => {
    const { service } = makeService(
      {},
      {},
      async () => {
        throw new Error('connection reset');
      },
    );
    const response = await service.ingestBatch({ batchId: 'b1', events: [makeEvent()] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({ status: 'RETRYABLE_ERROR', retryable: true });
    expect(response.results[0].acknowledgedAt).toBeNull();
  });

  it('collapses an inbox unique-violation race to DUPLICATE when the committed payload hash matches', async () => {
    const event = makeEvent();
    const { service } = makeService(
      {
        // The transaction throws before any lookup (simulated insert race);
        // the post-catch read then sees the concurrently committed row.
        findInboxEvent: vi.fn().mockResolvedValue({
          eventId: event.eventId,
          sequenceNo: event.sequenceNo,
          payloadSha256: sha256OfCanonicalJson(event),
        }),
      },
      {},
      async () => {
        const error = new Error('dup') as Error & { code: string; constraint: string };
        error.code = '23505';
        error.constraint = 'uq_hq_inbox_event';
        throw error;
      },
    );
    const response = await service.ingestBatch({ batchId: 'b1', events: [event] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({ status: 'DUPLICATE' });
  });

  it('maps a receipt-ownership unique violation to RECEIPT_CONFLICT', async () => {
    const { service } = makeService(
      {},
      {},
      async () => {
        const error = new Error('dup') as Error & { code: string; constraint: string };
        error.code = '23505';
        error.constraint = 'uq_hq_receipt';
        throw error;
      },
    );
    const response = await service.ingestBatch({ batchId: 'b1', events: [makeEvent()] }, OUTLET_A);
    expect(response.results[0]).toMatchObject({
      status: 'REJECTED_PERMANENT',
      detail: 'RECEIPT_CONFLICT',
    });
  });
});

describe('saleInvariantError', () => {
  it('accepts consistent totals', () => {
    expect(saleInvariantError(makeEvent())).toBeNull();
  });

  it('rejects when Σ subtotal ≠ totalMinor', () => {
    const event = makeEvent({ ...{} }) as SyncEventV1 & { data: { totalMinor: string } };
    event.data.totalMinor = '1';
    expect(saleInvariantError(event)).toBe('INVARIANT_TOTAL');
  });
});
