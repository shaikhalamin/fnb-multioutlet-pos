import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import type {
  CatalogChangeEntry,
  CatalogChangeItem,
  CatalogChangesResponse,
  MenuSnapshotItem,
  MenuSnapshotResponse,
} from './dto/menu-sync.dto.js';
import type { CatalogChangeRow, MenuPullRepository } from './menu-pull.repository.js';

/**
 * Menu pull surface (PRD §8.3): revisioned deltas for the authenticated
 * outlet, plus the single-response snapshot for bootstrap and gap recovery.
 * An empty change response is always well-formed (`changes: []`,
 * `hasMore: false`) — never a 404 and never a local-data-deleting signal
 * (FR-03).
 */
@Injectable()
export class MenuSyncService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly menuPull: MenuPullRepository,
  ) {}

  async getChanges(outletId: string, afterRevision: string, limit: number): Promise<CatalogChangesResponse> {
    const headRevision = await this.menuPull.headRevision(outletId);

    // Gap/truncation detection (AT-14): if the log no longer retains the row
    // right after the outlet's checkpoint, deltas cannot be served — the
    // client must rebuild from a snapshot instead of guessing.
    const minAvailable = await this.menuPull.minAvailableRevision(outletId);
    if (minAvailable !== null && BigInt(minAvailable) > BigInt(afterRevision) + 1n) {
      return {
        outletId,
        fromRevision: afterRevision,
        nextRevision: afterRevision,
        headRevision,
        hasMore: false,
        snapshotRequired: true,
        changes: [],
      };
    }

    const rows = await this.menuPull.listChangesAfter(outletId, afterRevision, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // The returned page must be contiguous from the checkpoint (§8.3 pull
    // algorithm); a middle gap is likewise snapshot territory.
    const contiguous =
      page.length === 0 ||
      (BigInt(page[0].revision) === BigInt(afterRevision) + 1n &&
        page.every(
          (row, index) => index === 0 || BigInt(row.revision) === BigInt(page[index - 1].revision) + 1n,
        ));
    if (!contiguous) {
      return {
        outletId,
        fromRevision: afterRevision,
        nextRevision: afterRevision,
        headRevision,
        hasMore: false,
        snapshotRequired: true,
        changes: [],
      };
    }

    const lastRevision = page.at(-1)?.revision ?? afterRevision;
    return {
      outletId,
      fromRevision: afterRevision,
      nextRevision: lastRevision,
      headRevision,
      hasMore,
      snapshotRequired: false,
      changes: page.map((row) => toChangeEntry(row)),
    };
  }

  /**
   * Single-response snapshot (scope decision): one REPEATABLE READ
   * transaction pins the revision and the full effective item set — active
   * and inactive (tombstones) — so the outlet can replace its catalog
   * atomically. `snapshotId` identifies this stable view.
   */
  async getSnapshot(outletId: string): Promise<MenuSnapshotResponse> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const snapshotRevision = await this.menuPull.headRevision(outletId, manager);
      const rows = await this.menuPull.listSnapshotItems(manager, outletId);
      return {
        snapshotId: randomUUID(),
        snapshotRevision,
        items: rows.map((row) => ({ ...row })),
      };
    });
  }
}

function toChangeEntry(row: CatalogChangeRow): CatalogChangeEntry {
  if (row.action === 'REMOVE') {
    // Tombstone: identity only, no item snapshot (the outlet keeps history).
    return { revision: row.revision, type: 'REMOVE', menuItemId: row.menuItemId ?? '', item: null };
  }
  const payload = row.payload as Partial<CatalogChangeItem>;
  const item: CatalogChangeItem = {
    assignmentId: String(payload.assignmentId ?? ''),
    sku: String(payload.sku ?? ''),
    name: String(payload.name ?? ''),
    description: String(payload.description ?? ''),
    category: String(payload.category ?? ''),
    unitPriceMinor: String(payload.unitPriceMinor ?? '0'),
    currencyCode: String(payload.currencyCode ?? ''),
    active: payload.active === true,
    itemVersion: Number(payload.itemVersion ?? 1),
  };
  return { revision: row.revision, type: 'UPSERT', menuItemId: row.menuItemId ?? '', item };
}
