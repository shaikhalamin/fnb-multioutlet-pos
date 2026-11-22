import { describe, expect, it, vi } from 'vitest';
import { InventoryService } from './inventory.service.js';
import type { InventoryRepository } from './inventory.repository.js';

function makeBalance(overrides: Partial<{ quantityOnHand: string; version: number }> = {}) {
  return {
    menuItemId: '11111111-1111-4111-8111-111111111111',
    quantityOnHand: overrides.quantityOnHand ?? '10',
    version: overrides.version ?? 3,
    updatedAt: new Date('2026-11-20T04:00:00Z'),
  };
}

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    catalogItemExists: vi.fn(async () => true),
    lockBalance: vi.fn(async () => makeBalance()),
    insertBalance: vi.fn(async (_m: unknown, input: { quantityOnHand: string }) => ({
      ...makeBalance({ version: 1 }),
      quantityOnHand: input.quantityOnHand,
    })),
    updateBalance: vi.fn(async (_m: unknown, id: string, qty: string, version: number) => ({
      ...makeBalance(),
      menuItemId: id,
      quantityOnHand: qty,
      version,
    })),
    appendMovement: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeDataSource() {
  const manager = { sentinel: 'tx-manager' };
  return {
    manager,
    transaction: vi.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn(manager)),
  };
}

function makeService(repo: ReturnType<typeof makeRepo>, dataSource = makeDataSource()) {
  return {
    service: new InventoryService(dataSource as never, repo as unknown as InventoryRepository),
    dataSource,
  };
}

const ITEM = '11111111-1111-4111-8111-111111111111';

describe('InventoryService.listBalances', () => {
  it('surfaces a never-stocked catalog item at quantity 0 and version 0', async () => {
    // PRD §8.8 bootstrapping: a freshly paired terminal has catalog rows but
    // no balance rows; the list must still show them so staff can restock.
    const catalogSyncedAt = new Date('2026-11-22T15:21:24Z');
    const repo = makeRepo({
      listBalances: vi.fn(async () => [
        {
          menuItemId: ITEM,
          name: 'Chicken Burger',
          sku: 'BURGER-01',
          quantityOnHand: '0',
          version: 0,
          updatedAt: catalogSyncedAt,
        },
      ]),
    });
    const { service } = makeService(repo);

    const rows = await service.listBalances();

    expect(rows).toEqual([
      {
        menuItemId: ITEM,
        name: 'Chicken Burger',
        sku: 'BURGER-01',
        quantityOnHand: 0,
        version: 0,
        updatedAt: catalogSyncedAt.toISOString(),
      },
    ]);
  });

  it('maps a stocked balance row through unchanged', async () => {
    const updatedAt = new Date('2026-11-20T04:00:00Z');
    const repo = makeRepo({
      listBalances: vi.fn(async () => [
        {
          menuItemId: ITEM,
          name: 'Cola',
          sku: 'COLA-01',
          quantityOnHand: '100',
          version: 2,
          updatedAt,
        },
      ]),
    });
    const { service } = makeService(repo);

    const rows = await service.listBalances();

    expect(rows).toEqual([
      {
        menuItemId: ITEM,
        name: 'Cola',
        sku: 'COLA-01',
        quantityOnHand: 100,
        version: 2,
        updatedAt: updatedAt.toISOString(),
      },
    ]);
  });
});

describe('InventoryService.adjust', () => {
  it('applies a positive delta, bumps version, and appends an audited movement', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    const result = await service.adjust(
      { menuItemId: ITEM, deltaQuantity: 50, reason: 'RESTOCK' },
      { userId: 'actor-1', requestId: 'req-1' },
    );

    expect(result.quantityOnHand).toBe(60);
    expect(result.version).toBe(4);
    expect(repo.appendMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        menuItemId: ITEM,
        deltaQuantity: '50',
        reason: 'RESTOCK',
        sourceSaleId: null,
        actorId: 'actor-1',
        requestId: 'req-1',
      }),
    );
  });

  it('applies a negative delta in bigint arithmetic', async () => {
    const repo = makeRepo({ lockBalance: vi.fn(async () => makeBalance({ quantityOnHand: '9007199254740993' })) });
    const { service } = makeService(repo);

    const result = await service.adjust(
      { menuItemId: ITEM, deltaQuantity: -3, reason: 'WRITE_OFF' },
      { userId: 'actor-1', requestId: null },
    );

    // 2^53 + 1 - 3 must NOT round-trip through Number: the update receives
    // the exact bigint string.
    expect(repo.updateBalance).toHaveBeenCalledWith(expect.anything(), ITEM, '9007199254740990', 4);
    expect(result.version).toBe(4);
  });

  it('rejects an adjustment that would go below zero with 422 + details', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await expect(
      service.adjust({ menuItemId: ITEM, deltaQuantity: -11, reason: 'WRITE_OFF' }, { userId: 'a', requestId: null }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'INSUFFICIENT_STOCK',
      details: { menuItemId: ITEM, requestedQuantity: -11, availableQuantity: 10 },
    });
    expect(repo.appendMovement).not.toHaveBeenCalled();
    expect(repo.updateBalance).not.toHaveBeenCalled();
  });

  it('rejects an adjustment for an item missing from the local catalog', async () => {
    const repo = makeRepo({ catalogItemExists: vi.fn(async () => false) });
    const { service, dataSource } = makeService(repo);

    await expect(
      service.adjust({ menuItemId: ITEM, deltaQuantity: 5, reason: 'RESTOCK' }, { userId: 'a', requestId: null }),
    ).rejects.toMatchObject({ status: 422, code: 'ITEM_NOT_ASSIGNED' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('inserts a balance row for the first stocking of an unbalanced item', async () => {
    const repo = makeRepo({ lockBalance: vi.fn(async () => null) });
    const { service } = makeService(repo);

    const result = await service.adjust(
      { menuItemId: ITEM, deltaQuantity: 40, reason: 'RESTOCK' },
      { userId: 'a', requestId: null },
    );

    expect(repo.insertBalance).toHaveBeenCalledWith(expect.anything(), {
      menuItemId: ITEM,
      quantityOnHand: '40',
    });
    expect(result.quantityOnHand).toBe(40);
    expect(result.version).toBe(1);
  });

  it('rejects a negative first adjustment (no balance row, delta < 0)', async () => {
    const repo = makeRepo({ lockBalance: vi.fn(async () => null) });
    const { service } = makeService(repo);

    await expect(
      service.adjust({ menuItemId: ITEM, deltaQuantity: -1, reason: 'RECOUNT' }, { userId: 'a', requestId: null }),
    ).rejects.toMatchObject({ status: 422, code: 'INSUFFICIENT_STOCK' });
    expect(repo.insertBalance).not.toHaveBeenCalled();
  });
});
