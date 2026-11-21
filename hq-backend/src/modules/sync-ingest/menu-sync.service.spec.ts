import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { MenuSyncService } from './menu-sync.service.js';
import type { CatalogChangeRow, MenuPullRepository } from './menu-pull.repository.js';

const OUTLET_A = '11111111-1111-4111-8111-111111111111';
const ITEM = '9708835e-2e21-465a-87e9-5f8d56cd44ab';

function upsertRow(revision: string): CatalogChangeRow {
  return {
    revision,
    action: 'UPSERT',
    payload: {
      assignmentId: '31fe8f6b-02b8-409d-b1fa-6c441f422949',
      menuItemId: ITEM,
      sku: 'BURGER-01',
      name: 'Chicken Burger',
      description: 'Grilled chicken burger',
      category: 'Burgers',
      unitPriceMinor: '1200',
      currencyCode: 'USD',
      active: true,
      itemVersion: 3,
    },
    menuItemId: ITEM,
  };
}

function removeRow(revision: string): CatalogChangeRow {
  return {
    revision,
    action: 'REMOVE',
    payload: { assignmentId: '31fe8f6b-02b8-409d-b1fa-6c441f422949', menuItemId: ITEM },
    menuItemId: ITEM,
  };
}

function makeService(rows: CatalogChangeRow[], opts: { min?: string | null; head?: string } = {}) {
  const menuPull = {
    headRevision: vi.fn().mockResolvedValue(opts.head ?? '10'),
    minAvailableRevision: vi.fn().mockResolvedValue(opts.min === undefined ? '1' : opts.min),
    listChangesAfter: vi.fn().mockResolvedValue(rows),
    listSnapshotItems: vi.fn().mockResolvedValue([]),
  };
  const dataSource = {
    transaction: vi.fn((_isolation: string, cb: (manager: unknown) => Promise<unknown>) =>
      cb({})),
  };
  const service = new MenuSyncService(
    dataSource as unknown as DataSource,
    menuPull as unknown as MenuPullRepository,
  );
  return { service, menuPull };
}

describe('MenuSyncService.getChanges', () => {
  it('returns ascending contiguous changes and advances nextRevision to the page end', async () => {
    const { service, menuPull } = makeService([upsertRow('11'), removeRow('12')], { head: '12' });
    const response = await service.getChanges(OUTLET_A, '10', 500);

    expect(response).toMatchObject({
      outletId: OUTLET_A,
      fromRevision: '10',
      nextRevision: '12',
      headRevision: '12',
      hasMore: false,
      snapshotRequired: false,
    });
    expect(response.changes.map((change) => change.revision)).toEqual(['11', '12']);
    expect(menuPull.listChangesAfter).toHaveBeenCalledWith(OUTLET_A, '10', 501, expect.anything());
    // UPSERT carries the full item snapshot; REMOVE is a bare tombstone.
    expect(response.changes[0].item).toMatchObject({ unitPriceMinor: '1200', itemVersion: 3 });
    expect(response.changes[1].item).toBeNull();
  });

  it('serves strictly after the afterRevision boundary only', async () => {
    const { service, menuPull } = makeService([]);
    await service.getChanges(OUTLET_A, '42', 500);
    expect(menuPull.listChangesAfter).toHaveBeenCalledWith(OUTLET_A, '42', 501, expect.anything());
  });

  it('signals hasMore when the page is truncated by the limit', async () => {
    const rows = [upsertRow('11'), upsertRow('12'), upsertRow('13')];
    const { service } = makeService(rows, { head: '13' });
    const response = await service.getChanges(OUTLET_A, '10', 2);
    expect(response.hasMore).toBe(true);
    expect(response.nextRevision).toBe('12');
    expect(response.changes).toHaveLength(2);
  });

  it('returns an empty, well-formed response when the outlet is at head (FR-03)', async () => {
    const { service } = makeService([], { head: '7' });
    const response = await service.getChanges(OUTLET_A, '7', 500);
    expect(response).toMatchObject({
      changes: [],
      hasMore: false,
      snapshotRequired: false,
      fromRevision: '7',
      nextRevision: '7',
      headRevision: '7',
    });
  });

  it('demands a snapshot when retained history starts after the checkpoint (truncation)', async () => {
    const { service } = makeService([], { min: '6', head: '10' });
    const response = await service.getChanges(OUTLET_A, '4', 500);
    expect(response.snapshotRequired).toBe(true);
    expect(response.changes).toEqual([]);
    expect(response.nextRevision).toBe('4'); // checkpoint must not advance
  });

  it('demands a snapshot when the change log was fully compacted (no retained rows, head beyond checkpoint)', async () => {
    const { service } = makeService([], { min: null, head: '10' });
    const response = await service.getChanges(OUTLET_A, '4', 500);
    expect(response.snapshotRequired).toBe(true);
    expect(response.changes).toEqual([]);
    expect(response.nextRevision).toBe('4'); // checkpoint must not advance
  });

  it('stays at head without a snapshot when nothing was ever retained for this outlet', async () => {
    const { service } = makeService([], { min: null, head: '7' });
    const response = await service.getChanges(OUTLET_A, '7', 500);
    expect(response).toMatchObject({ changes: [], hasMore: false, snapshotRequired: false, headRevision: '7' });
  });

  it('demands a snapshot on a middle gap in the returned page', async () => {
    const { service } = makeService([upsertRow('11'), upsertRow('13')], { head: '13' });
    const response = await service.getChanges(OUTLET_A, '10', 500);
    expect(response.snapshotRequired).toBe(true);
    expect(response.changes).toEqual([]);
  });

  it('never queries another outlet: the repository receives the key outlet only', async () => {
    const { service, menuPull } = makeService([]);
    await service.getChanges(OUTLET_A, '0', 500);
    expect(menuPull.listChangesAfter.mock.calls.every((call) => call[0] === OUTLET_A)).toBe(true);
  });
});

describe('MenuSyncService.getSnapshot', () => {
  it('builds the snapshot revision and items in one repeatable-read transaction', async () => {
    const items = [
      {
        menuItemId: ITEM,
        assignmentId: '31fe8f6b-02b8-409d-b1fa-6c441f422949',
        sku: 'BURGER-01',
        name: 'Chicken Burger',
        description: '',
        category: 'Burgers',
        unitPriceMinor: '1200',
        currencyCode: 'USD',
        active: true,
        itemVersion: 3,
      },
    ];
    const menuPull = {
      headRevision: vi.fn().mockResolvedValue('42'),
      minAvailableRevision: vi.fn(),
      listChangesAfter: vi.fn(),
      listSnapshotItems: vi.fn().mockResolvedValue(items),
    };
    const dataSource = {
      transaction: vi.fn((isolation: string, cb: (manager: unknown) => Promise<unknown>) => {
        expect(isolation).toBe('REPEATABLE READ');
        return cb({});
      }),
    };
    const service = new MenuSyncService(
      dataSource as unknown as DataSource,
      menuPull as unknown as MenuPullRepository,
    );

    const snapshot = await service.getSnapshot(OUTLET_A);
    expect(snapshot.snapshotRevision).toBe('42');
    expect(snapshot.items).toEqual(items);
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
