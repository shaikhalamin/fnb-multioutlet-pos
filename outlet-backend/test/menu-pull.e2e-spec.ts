import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { DataSource as PgDataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/config/database.config.js';
import type { ConfigService } from '@nestjs/config';
import type { CatalogChangesResponse } from '../src/modules/sync/clients/generated/types/CatalogChangesResponse.js';
import type { CatalogChangeEntry } from '../src/modules/sync/clients/generated/types/CatalogChangeEntry.js';
import type { MenuSnapshotResponse } from '../src/modules/sync/clients/generated/types/MenuSnapshotResponse.js';
import type { HqSyncClient } from '../src/modules/sync/clients/hq-sync.client.js';
import { MenuApplyRepository } from '../src/modules/sync/repositories/menu-apply.repository.js';
import { MenuPullService } from '../src/modules/sync/services/menu-pull.service.js';

/**
 * Menu pull + snapshot apply against real PostgreSQL (PRD §8.3, AT-13/AT-14):
 * the whole batch (or snapshot) and the checkpoint commit in ONE local
 * transaction; injected mid-apply failures leave nothing behind and the
 * checkpoint untouched, so a retry is always safe.
 */
const hasDependencies =
  Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL?.includes('vitest');
const describeWithDeps = hasDependencies ? describe : describe.skip;

/** A throwaway outlet scope so the spec never disturbs the seeded outlet. */
const TEST_OUTLET = randomUUID();

const upsert = (revision: number, menuItemId: string, overrides: Record<string, unknown> = {}): CatalogChangeEntry =>
  ({
    revision: String(revision),
    type: 'UPSERT',
    menuItemId,
    item: {
      assignmentId: randomUUID(),
      sku: `TEST-${menuItemId.slice(0, 8)}`,
      name: 'Test item',
      description: '',
      category: 'Tests',
      unitPriceMinor: '1000',
      currencyCode: 'USD',
      active: true,
      itemVersion: 1,
      ...overrides,
    },
  }) as CatalogChangeEntry;

describeWithDeps('MenuPullService (real PostgreSQL)', () => {
  let dataSource: DataSource;
  const cleanupIds: string[] = [];
  /** Snapshot apply tombstones absent rows — remember what was active so the
   *  shared dev database (auth/sales e2e read it in parallel) is restored. */
  let previouslyActiveIds: string[] = [];

  function makeService(
    changes: CatalogChangesResponse,
    snapshot?: MenuSnapshotResponse,
    outletId = TEST_OUTLET,
  ): MenuPullService {
    const hq = {
      getMenuChanges: async () => changes,
      getMenuSnapshot: async () => {
        if (!snapshot) throw new Error('transport down');
        return snapshot;
      },
    } as unknown as HqSyncClient;
    const config = { get: (key: string) => (key === 'OUTLET_ID' ? outletId : undefined) };
    return new MenuPullService(
      dataSource,
      hq,
      new MenuApplyRepository(dataSource),
      config as unknown as ConfigService<never, true>,
    );
  }

  /** Current checkpoint for the test outlet. */
  async function revision(): Promise<number> {
    const rows = await dataSource.query<Array<{ rev: string }>>(
      'SELECT last_applied_revision::text AS rev FROM menu_sync_state WHERE outlet_id = $1',
      [TEST_OUTLET],
    );
    return Number(rows[0]?.rev ?? '0');
  }

  /** A reply page continuing from the live checkpoint. */
  function page(changes: CatalogChangeEntry[], nextRevision?: number): CatalogChangesResponse {
    const next = nextRevision ?? Math.max(Number(changes.at(-1)?.revision ?? 0), 0);
    return {
      outletId: TEST_OUTLET,
      fromRevision: '0',
      nextRevision: String(next),
      headRevision: String(next),
      hasMore: false,
      snapshotRequired: false,
      changes,
    };
  }

  beforeAll(async () => {
    dataSource = new PgDataSource(buildDataSourceOptions(process.env.DATABASE_URL!));
    await dataSource.initialize();
    const active = await dataSource.query<Array<{ id: string }>>(
      'SELECT menu_item_id::text AS id FROM catalog_items WHERE active = true',
    );
    previouslyActiveIds = active.map((row) => row.id);
    await dataSource.query(
      'INSERT INTO menu_sync_state (outlet_id, last_applied_revision, last_sync_at) VALUES ($1, $2, now())',
      [TEST_OUTLET, '0'],
    );
  });

  afterAll(async () => {
    if (!dataSource) return;
    for (const id of cleanupIds) {
      await dataSource.query('DELETE FROM catalog_items WHERE menu_item_id = $1', [id]);
    }
    if (previouslyActiveIds.length > 0) {
      await dataSource.query('UPDATE catalog_items SET active = true WHERE menu_item_id = ANY($1::uuid[])', [
        previouslyActiveIds,
      ]);
    }
    await dataSource.query('DELETE FROM menu_sync_state WHERE outlet_id = $1', [TEST_OUTLET]);
    await dataSource.destroy();
  });

  it('applies a delta page atomically with the checkpoint', async () => {
    const base = await revision();
    const item = randomUUID();
    cleanupIds.push(item);

    const result = await makeService(
      page([upsert(base + 1, item), upsert(base + 2, item, { unitPriceMinor: '1250', itemVersion: 2 })]),
    ).pullAndApply();

    expect(result).toMatchObject({ applied: 2, nextRevision: String(base + 2), snapshotApplied: false });
    const row = await dataSource.query(
      'SELECT effective_price_minor::text AS price, active, hq_item_version FROM catalog_items WHERE menu_item_id = $1',
      [item],
    );
    expect(row[0]).toMatchObject({ price: '1250', active: true, hq_item_version: 2 });
    expect(await revision()).toBe(base + 2);
  });

  it('AT-13: an injected mid-apply failure rolls back everything; the checkpoint never advances', async () => {
    const base = await revision();
    const good = randomUUID();
    const poisoned = randomUUID();
    cleanupIds.push(good, poisoned);

    const changes = page([
      upsert(base + 1, good),
      upsert(base + 2, poisoned, { unitPriceMinor: '-5' }), // CHECK violation mid-apply
    ]);
    await expect(makeService(changes).pullAndApply()).rejects.toThrow();

    // Nothing committed — neither row nor checkpoint.
    const rows = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM catalog_items WHERE menu_item_id IN ($1, $2)',
      [good, poisoned],
    );
    expect(rows[0].count).toBe(0);
    expect(await revision()).toBe(base);

    // Safe retry with the same page minus the poison succeeds (AT-13).
    const retry = page([upsert(base + 1, good), upsert(base + 2, good, { unitPriceMinor: '1100' })]);
    await expect(makeService(retry).pullAndApply()).resolves.toMatchObject({ applied: 2 });
    expect(await revision()).toBe(base + 2);
  });

  it('treats an empty change response as a no-op that only refreshes last_sync_at (FR-03)', async () => {
    const base = await revision();
    const rowsBefore = await dataSource.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM catalog_items',
    );
    const result = await makeService(page([], base)).pullAndApply();
    expect(result.applied).toBe(0);
    expect(await revision()).toBe(base);
    const rowsAfter = await dataSource.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM catalog_items',
    );
    expect(rowsAfter[0].count).toBe(rowsBefore[0].count); // no local data deleted
  });

  it('re-applies a fully redelivered page as a no-op (revisions ≤ checkpoint)', async () => {
    const base = await revision();
    const item = randomUUID();
    cleanupIds.push(item);
    await makeService(page([upsert(base + 1, item)])).pullAndApply();
    const result = await makeService(page([upsert(base + 1, item)], base + 1)).pullAndApply();
    expect(result.applied).toBe(0);
    expect(await revision()).toBe(base + 1);
  });

  it('AT-12 leg: applying a REMOVE tombstone deactivates the item (row kept)', async () => {
    const base = await revision();
    const item = randomUUID();
    cleanupIds.push(item);
    await makeService(page([upsert(base + 1, item)])).pullAndApply();

    const remove = {
      revision: String(base + 2),
      type: 'REMOVE',
      menuItemId: item,
      item: null,
    } as CatalogChangeEntry;
    await makeService(page([remove])).pullAndApply();

    const row = await dataSource.query<Array<{ active: boolean }>>(
      'SELECT active FROM catalog_items WHERE menu_item_id = $1',
      [item],
    );
    expect(row[0].active).toBe(false); // tombstoned, row retained for history
  });

  it('routes a snapshotRequired reply to the atomic snapshot rebuild (AT-14)', async () => {
    const base = await revision();
    const keep = randomUUID();
    const add = randomUUID();
    const drop = randomUUID();
    cleanupIds.push(keep, add, drop);

    await makeService(page([upsert(base + 1, keep), upsert(base + 1, drop)])).pullAndApply();

    const snapshotItems = [
      { ...upsert(base + 10, keep, { unitPriceMinor: '777' }).item, menuItemId: keep },
      { ...upsert(base + 10, add).item, menuItemId: add },
    ];
    const service = makeService(
      { ...page([], base), snapshotRequired: true },
      {
        snapshotId: randomUUID(),
        snapshotRevision: String(base + 10),
        items: snapshotItems,
      } as unknown as MenuSnapshotResponse,
    );
    const result = await service.pullAndApply();
    expect(result.snapshotApplied).toBe(true);

    const kept = await dataSource.query('SELECT effective_price_minor::text AS price FROM catalog_items WHERE menu_item_id = $1', [keep]);
    const dropped = await dataSource.query('SELECT active FROM catalog_items WHERE menu_item_id = $1', [drop]);
    const added = await dataSource.query('SELECT active FROM catalog_items WHERE menu_item_id = $1', [add]);
    expect(kept[0].price).toBe('777');
    expect(dropped[0].active).toBe(false); // absent from the snapshot → tombstoned
    expect(added[0].active).toBe(true);

    const checkpoint = await dataSource.query<Array<{ rev: string; snapshot: string | null }>>(
      'SELECT last_applied_revision::text AS rev, snapshot_id::text AS snapshot FROM menu_sync_state WHERE outlet_id = $1',
      [TEST_OUTLET],
    );
    expect(checkpoint[0].rev).toBe(String(base + 10));
    expect(checkpoint[0].snapshot).toBeTruthy();
  });

  it('refuses to apply a reply scoped to another outlet (§8.3)', async () => {
    const base = await revision();
    const reply = { ...page([upsert(base + 1, randomUUID())]), outletId: randomUUID() };
    await expect(makeService(reply).pullAndApply()).rejects.toThrow(/does not match local identity/);
    expect(await revision()).toBe(base);
  });
});
