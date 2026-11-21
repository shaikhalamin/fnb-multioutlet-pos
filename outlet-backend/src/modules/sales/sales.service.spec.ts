import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { hashRequest, mergeLines, SalesService } from './sales.service.js';
import type { SalesRepository } from './sales.repository.js';
import type { ReceiptCounterRepository } from '../receipts/receipt-counter.repository.js';
import type { OutboxRepository } from '../outbox/outbox.repository.js';

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';
const USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'cashier@outlet-a.local',
  roleCodes: ['OUTLET_CASHIER'],
  permissions: ['sales.create'],
  outletId: OUTLET_ID,
};

const NOW = new Date('2026-11-20T04:02:03Z');

function catalogItem(menuItemId: string, overrides: Partial<{ effectivePriceMinor: string; active: boolean }> = {}) {
  return {
    menuItemId,
    assignmentId: 'a-' + menuItemId,
    sku: 'SKU-' + menuItemId.slice(0, 4),
    name: 'Item ' + menuItemId.slice(0, 4),
    description: '',
    category: 'Cat',
    effectivePriceMinor: overrides.effectivePriceMinor ?? '1200',
    currencyCode: 'USD',
    active: overrides.active ?? true,
    hqItemVersion: 1,
    appliedRevision: '1',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSalesRepo(overrides: Record<string, unknown> = {}) {
  return {
    lockIdempotencyKey: vi.fn(async () => undefined),
    findIdempotencyKey: vi.fn(async () => null),
    insertIdempotencyKey: vi.fn(async () => undefined),
    getSyncState: vi.fn(async () => ({ outletId: OUTLET_ID, lastAppliedRevision: '1', lastSyncAt: NOW, snapshotId: null })),
    loadCatalogItems: vi.fn(async (_m: unknown, ids: string[]) => ids.map((id) => catalogItem(id))),
    decrementStock: vi.fn(async () => ({ quantity_on_hand: '0' })),
    currentStock: vi.fn(async () => '0'),
    insertSale: vi.fn(async () => undefined),
    insertSaleItems: vi.fn(async () => undefined),
    insertSaleMovements: vi.fn(async () => undefined),
    findSaleById: vi.fn(async () => null),
    findSaleItems: vi.fn(async () => []),
    listSales: vi.fn(async () => ({ sales: [], nextCursor: undefined })),
    ...overrides,
  };
}

function makeCollaborators() {
  const receiptCounters = {
    allocate: vi.fn(async () => ({ receiptNumber: '1', receiptNo: 'A-000001' })),
  };
  const outbox = {
    insertSaleCompletedEvent: vi.fn(async () => undefined),
    findStatusBySaleId: vi.fn(async () => null),
  };
  return { receiptCounters, outbox };
}

function makeService(
  salesRepoOverrides: Record<string, unknown> = {},
  collaborators = makeCollaborators(),
) {
  const salesRepo = makeSalesRepo(salesRepoOverrides);
  const dataSource = {
    transaction: vi.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ manager: true })),
  };
  const config = new ConfigService<Env, true>({
    OUTLET_ID,
    OFFLINE_GRACE_HOURS: 72,
  });
  const service = new SalesService(
    dataSource as never,
    salesRepo as unknown as SalesRepository,
    collaborators.receiptCounters as unknown as ReceiptCounterRepository,
    collaborators.outbox as unknown as OutboxRepository,
    config,
  );
  return { service, salesRepo, dataSource, ...collaborators };
}

const ACTOR = { idempotencyKey: 'pos-1-key-0001', user: USER, requestId: 'req-1' };

describe('mergeLines (PRD §7.3 normalize-by-ID)', () => {
  it('sums duplicate lines and sorts deterministically by menuItemId', () => {
    const merged = mergeLines([
      { menuItemId: 'c', quantity: 1 },
      { menuItemId: 'a', quantity: 2 },
      { menuItemId: 'a', quantity: 3 },
      { menuItemId: 'b', quantity: 1 },
    ]);
    expect(merged).toEqual([
      { menuItemId: 'a', quantity: 5 },
      { menuItemId: 'b', quantity: 1 },
      { menuItemId: 'c', quantity: 1 },
    ]);
  });

  it('produces a stable request hash for the same content in any line order', () => {
    const a = hashRequest('key', mergeLines([{ menuItemId: 'x', quantity: 1 }, { menuItemId: 'y', quantity: 2 }]));
    const b = hashRequest('key', mergeLines([{ menuItemId: 'y', quantity: 2 }, { menuItemId: 'x', quantity: 1 }]));
    const c = hashRequest('other-key', mergeLines([{ menuItemId: 'x', quantity: 1 }, { menuItemId: 'y', quantity: 2 }]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('SalesService.createSale', () => {
  it('prices in BigInt: 2×1200 + 1×1500 = 3900 (AT-03 math)', async () => {
    const { service, salesRepo, outbox, receiptCounters } = makeService({
      loadCatalogItems: vi.fn(async (_m: unknown, ids: string[]) => {
        const items = [catalogItem(ids[0], { effectivePriceMinor: '1200' }), catalogItem(ids[1], { effectivePriceMinor: '1500' })];
        return ids.length === 1 ? items.slice(0, 1) : items;
      }),
    });

    const sale = await service.createSale(
      { items: [
        { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 2 },
        { menuItemId: '97000000-0000-4000-8000-000000000002', quantity: 1 },
      ] } as never,
      ACTOR,
    );

    expect(sale.totalMinor).toBe('3900');
    expect(sale.status).toBe('COMPLETED');
    expect(sale.receiptNo).toBe('A-000001');
    expect(sale.syncStatus).toBe('PENDING');
    expect(sale.items).toHaveLength(2);
    // Line snapshots + movements + outbox + idempotency all written once.
    expect(salesRepo.insertSaleItems).toHaveBeenCalledTimes(1);
    expect(salesRepo.insertSaleMovements).toHaveBeenCalledTimes(1);
    expect(outbox.insertSaleCompletedEvent).toHaveBeenCalledTimes(1);
    expect(salesRepo.insertIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(receiptCounters.allocate).toHaveBeenCalledTimes(1);
  });

  it('merges duplicate lines into one sale line (unique sale_id, menu_item_id)', async () => {
    const { service, salesRepo } = makeService();

    await service.createSale(
      { items: [
        { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 2 },
        { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 3 },
      ] } as never,
      ACTOR,
    );

    const rows = (salesRepo.insertSaleItems as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{ quantity: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(5);
  });

  it('replays the stored response for the same key + same payload (AT-07)', async () => {
    const stored = {
      id: 'sale-existing',
      receiptNo: 'A-000009',
      totalMinor: '1200',
      syncStatus: 'PENDING',
    };
    const { service, salesRepo, outbox, receiptCounters } = makeService({
      findIdempotencyKey: vi.fn(async () => ({
        requestSha256: hashRequest(ACTOR.idempotencyKey, [
          { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 },
        ]),
        responseJson: stored,
      })),
    });

    const result = await service.createSale(
      { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 }] } as never,
      ACTOR,
    );

    expect(result).toEqual(stored as never);
    // Zero side effects: no deduction, no receipt, no event.
    expect(salesRepo.decrementStock).not.toHaveBeenCalled();
    expect(receiptCounters.allocate).not.toHaveBeenCalled();
    expect(outbox.insertSaleCompletedEvent).not.toHaveBeenCalled();
  });

  it('rejects the same key with a different payload with 409 IDEMPOTENCY_KEY_REUSED (AT-08)', async () => {
    const { service } = makeService({
      findIdempotencyKey: vi.fn(async () => ({
        requestSha256: hashRequest(ACTOR.idempotencyKey, [
          { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 },
        ]),
        responseJson: { id: 'sale-existing' },
      })),
    });

    await expect(
      service.createSale(
        { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 2 }] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('throws 409 INSUFFICIENT_STOCK with line details and rolls back (AT-04)', async () => {
    const { service, salesRepo, receiptCounters } = makeService({
      decrementStock: vi.fn(async () => null),
      currentStock: vi.fn(async () => '3'),
    });

    await expect(
      service.createSale(
        { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 5 }] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      details: {
        menuItemId: '97000000-0000-4000-8000-000000000001',
        requestedQuantity: 5,
        availableQuantity: 3,
      },
    });
    // No sale-side writes happened after the failed decrement.
    expect(receiptCounters.allocate).not.toHaveBeenCalled();
    expect(salesRepo.insertSale).not.toHaveBeenCalled();
  });

  it('blocks sales with 503 when the menu sync is older than the grace window (AT-11)', async () => {
    const stale = new Date(NOW.getTime() - 73 * 3_600_000);
    const { service } = makeService({
      getSyncState: vi.fn(async () => ({ outletId: OUTLET_ID, lastAppliedRevision: '1', lastSyncAt: stale, snapshotId: null })),
    });

    vi.useFakeTimers({ now: NOW.getTime() });
    try {
      await expect(
        service.createSale(
          { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 }] } as never,
          ACTOR,
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: 'SYNC_TEMPORARILY_UNAVAILABLE',
        details: { offlineGraceHours: 72, lastMenuSyncAt: stale.toISOString() },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks sales with 503 when no sync state exists at all', async () => {
    const { service } = makeService({ getSyncState: vi.fn(async () => null) });

    await expect(
      service.createSale(
        { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'SYNC_TEMPORARILY_UNAVAILABLE' });
  });

  it('rejects unknown items with 422 ITEM_NOT_ASSIGNED', async () => {
    const { service } = makeService({ loadCatalogItems: vi.fn(async () => []) });

    await expect(
      service.createSale(
        { items: [{ menuItemId: '97000000-0000-4000-8000-000000000009', quantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ITEM_NOT_ASSIGNED' });
  });

  it('rejects inactive items with 422 ITEM_INACTIVE', async () => {
    const { service } = makeService({
      loadCatalogItems: vi.fn(async (_m: unknown, ids: string[]) =>
        ids.map((id) => catalogItem(id, { active: false })),
      ),
    });

    await expect(
      service.createSale(
        { items: [{ menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'ITEM_INACTIVE' });
  });

  it('rejects merged quantities beyond the per-line ceiling', async () => {
    const { service } = makeService();

    await expect(
      service.createSale(
        { items: [
          { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 60_000 },
          { menuItemId: '97000000-0000-4000-8000-000000000001', quantity: 60_000 },
        ] } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
  });
});
