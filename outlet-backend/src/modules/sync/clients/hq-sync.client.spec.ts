import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ResolvedRequest, Transport } from './generated/.kubb/client.js';
import { HqSyncClient, HqSyncError } from './hq-sync.client.js';
import type { SyncEventV1 } from './generated/types/SyncEventV1.js';

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'ok_dev_testkey';
const SECRET = 'test-secret-value-never-logged';

const VALID_CHANGES = {
  outletId: OUTLET_ID,
  fromRevision: '1',
  nextRevision: '2',
  headRevision: '2',
  hasMore: false,
  snapshotRequired: false,
  changes: [],
};

function makeConfig(): ConfigService<never, true> {
  const values: Record<string, string> = {
    HQ_OUTLET_KEY_ID: KEY_ID,
    HQ_OUTLET_KEY_SECRET: SECRET,
    HQ_API_BASE_URL: 'http://hq-api:3000/api/v1',
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<never, true>;
}

/** Fake transport capturing requests and answering with canned Responses. */
function makeTransport(responder: (request: ResolvedRequest, call: number) => Promise<Response>) {
  const requests: ResolvedRequest[] = [];
  let calls = 0;
  const transport: Transport = async (request) => {
    calls += 1;
    requests.push(request);
    return responder(request, calls);
  };
  return { transport, requests };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Case-insensitive header read for ResolvedRequest.headers records. */
function header(request: ResolvedRequest, name: string): string | undefined {
  const target = name.toLowerCase();
  const key = Object.keys(request.headers).find((candidate) => candidate.toLowerCase() === target);
  return key === undefined ? undefined : request.headers[key];
}

const EVENT: SyncEventV1 = {
  eventId: '3feeb5c0-53fa-476e-a758-3040a3529041',
  eventType: 'sale.completed',
  schemaVersion: 1,
  outletId: OUTLET_ID,
  sequenceNo: '1',
  occurredAt: '2026-11-20T04:02:03.000Z',
  data: {
    saleId: '0a44e56a-628e-492a-81e0-83f4a4d68f76',
    receiptNo: 'A-000001',
    catalogRevision: '1',
    currencyCode: 'USD',
    status: 'COMPLETED',
    soldAt: '2026-11-20T04:02:03.000Z',
    totalMinor: '1200',
    items: [
      {
        saleItemId: '64750166-32a4-46f8-9285-f536f5b03213',
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

describe('HqSyncClient', () => {
  it('injects the OutletKey authorization and a fresh X-Request-Id on every call', async () => {
    const { transport, requests } = makeTransport(async () => jsonResponse({ data: VALID_CHANGES }));
    const client = new HqSyncClient(makeConfig() as never, transport);

    await client.getMenuChanges('1', 500);

    expect(requests).toHaveLength(1);
    expect(header(requests[0], 'authorization')).toBe(`OutletKey ${KEY_ID}.${SECRET}`);
    expect(header(requests[0], 'x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('strips the ApiSuccess envelope and validates the payload with the generated schema', async () => {
    const { transport } = makeTransport(async () =>
      jsonResponse({ data: VALID_CHANGES, meta: { requestId: 'req_1', timestamp: '2026-11-20T04:00:00.000Z' } }),
    );
    const client = new HqSyncClient(makeConfig() as never, transport);

    const changes = await client.getMenuChanges('1', 500);
    expect(changes).toEqual(VALID_CHANGES);
  });

  it('rejects a malformed HQ reply as a retryable CONTRACT_MISMATCH (§8.3)', async () => {
    const { transport } = makeTransport(async () =>
      jsonResponse({ data: { outletId: OUTLET_ID, changes: 'not-an-array' } }),
    );
    const client = new HqSyncClient(makeConfig() as never, transport);

    await expect(client.getMenuChanges('1', 500)).rejects.toMatchObject({
      name: 'HqSyncError',
      code: 'CONTRACT_MISMATCH',
      status: null,
    });
  });

  it('carries one stable Idempotency-Key across a network retry of the same batch bytes', async () => {
    const { transport, requests } = makeTransport(async (request, call) => {
      if (call === 1) throw new Error('socket hang up');
      return jsonResponse({
        data: {
          batchId: header(requests[0], 'idempotency-key'),
          results: [{ eventId: EVENT.eventId, status: 'ACCEPTED', retryable: false, acknowledgedAt: '2026-11-20T04:02:10.000Z' }],
          highestContiguousSequence: '1',
        },
      });
    });
    const client = new HqSyncClient(makeConfig() as never, transport);

    await expect(client.pushEventBatch([EVENT], 'batch-key-1')).rejects.toMatchObject({ code: 'HQ_UNREACHABLE' });
    const response = await client.pushEventBatch([EVENT], 'batch-key-1');
    expect(response.results[0]).toMatchObject({ status: 'ACCEPTED' });

    const keys = requests.map((request) => header(request, 'idempotency-key'));
    expect(keys).toEqual(['batch-key-1', 'batch-key-1']);
    expect(header(requests[1], 'authorization')).toBe(`OutletKey ${KEY_ID}.${SECRET}`);
  });

  it('maps an HQ 429 with Retry-After into sanitized retry guidance', async () => {
    const { transport } = makeTransport(async () =>
      jsonResponse({ error: { code: 'RATE_LIMITED', message: 'Too many requests.', requestId: 'req_2' } }, 429, {
        'retry-after': '7',
      }),
    );
    const client = new HqSyncClient(makeConfig() as never, transport);

    const error = await client.getMenuChanges('1', 500).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HqSyncError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 7 });
    // The sanitized error never contains the machine secret.
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it('never leaks the secret through transport-level failures', async () => {
    const { transport } = makeTransport(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new HqSyncClient(makeConfig() as never, transport);

    const error = await client.getCheckpoint().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'HQ_UNREACHABLE', status: null });
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it('sends heartbeats with the parsed acknowledgement', async () => {
    const { transport } = makeTransport(async () =>
      jsonResponse({ data: { acknowledgedAt: '2026-11-20T04:03:00.000Z' } }),
    );
    const client = new HqSyncClient(makeConfig() as never, transport);
    const acknowledged = await client.sendHeartbeat({
      appliedMenuRevision: '42',
      pendingOutboxCount: 0,
      quarantinedCount: 0,
    });
    expect(acknowledged.acknowledgedAt).toBe('2026-11-20T04:03:00.000Z');
  });
});
