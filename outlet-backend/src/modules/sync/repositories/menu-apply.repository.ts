import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module.js';
import { CatalogItemEntity } from '../../../database/entities/catalog-item.entity.js';
import { MenuSyncStateEntity } from '../../../database/entities/menu-sync-state.entity.js';
import type { CatalogChangeEntry } from '../clients/generated/types/CatalogChangeEntry.js';
import type { MenuSnapshotItem } from '../clients/generated/types/MenuSnapshotItem.js';
import type { MenuSnapshotResponse } from '../clients/generated/types/MenuSnapshotResponse.js';

export type AppliedChange = Pick<CatalogChangeEntry, 'revision' | 'type' | 'menuItemId' | 'item'>;

/**
 * Local catalog writes for the menu sync (PRD §6.2, §8.3): every method runs
 * entirely inside the caller's transaction, so a page (or snapshot) applies
 * atomically with the `menu_sync_state` checkpoint — the checkpoint never
 * advances before the writes commit (AT-13).
 */
@Injectable()
export class MenuApplyRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * Upserts one effective item by HQ ID; identity never changes locally
   * (§8.3: a repeated response must apply safely).
   */
  private async upsertItem(
    manager: EntityManager,
    item: MenuSnapshotItem,
    appliedRevision: string,
  ): Promise<void> {
    await manager
      .getRepository(CatalogItemEntity)
      .createQueryBuilder()
      .insert()
      .values({
        menuItemId: item.menuItemId,
        assignmentId: item.assignmentId,
        sku: item.sku,
        name: item.name,
        description: item.description,
        category: item.category,
        effectivePriceMinor: item.unitPriceMinor,
        currencyCode: item.currencyCode,
        active: item.active,
        hqItemVersion: item.itemVersion,
        appliedRevision,
      })
      .orUpdate(
        [
          'assignment_id',
          'sku',
          'name',
          'description',
          'category',
          'effective_price_minor',
          'currency_code',
          'active',
          'hq_item_version',
          'applied_revision',
          'updated_at',
        ],
        ['menu_item_id'],
        { skipUpdateIfNoValuesChanged: false },
      )
      .updateEntity(false)
      .execute();
  }

  /** Soft-deactivates a row (kept for the inventory FK + receipt history). */
  private async deactivateItem(
    manager: EntityManager,
    menuItemId: string,
    appliedRevision: string,
  ): Promise<void> {
    await manager
      .getRepository(CatalogItemEntity)
      .createQueryBuilder()
      .update(CatalogItemEntity)
      .set({ active: false, appliedRevision, updatedAt: new Date() })
      .where('menu_item_id = :menuItemId', { menuItemId })
      .execute();
  }

  /**
   * Applies one delta page and advances the checkpoint in the same
   * transaction. Revisions at or below the current checkpoint are no-ops;
   * an empty page writes nothing except the fresh `last_sync_at` heartbeat
   * (FR-03: an empty change response never deletes local data).
   */
  async applyChanges(
    manager: EntityManager,
    outletId: string,
    lastAppliedRevision: string,
    changes: ReadonlyArray<AppliedChange>,
    nextRevision: string,
    now: Date,
  ): Promise<number> {
    let applied = 0;
    for (const change of changes) {
      if (BigInt(change.revision) <= BigInt(lastAppliedRevision)) continue; // idempotent no-op
      if (change.type === 'UPSERT' && change.item) {
        await this.upsertItem(manager, { ...change.item, menuItemId: change.menuItemId }, change.revision);
      } else {
        await this.deactivateItem(manager, change.menuItemId, change.revision);
      }
      applied += 1;
    }
    await this.advanceCheckpoint(manager, outletId, nextRevision, now);
    return applied;
  }

  /**
   * Replaces the catalog from a full snapshot in one transaction: upserts
   * every snapshot item (tombstones carry `active:false`), deactivates local
   * items absent from the snapshot, and pins the checkpoint + `snapshot_id`
   * (§8.3 snapshot correctness — never infer removal from a missing page).
   */
  async applySnapshot(
    manager: EntityManager,
    outletId: string,
    snapshot: MenuSnapshotResponse,
    now: Date,
  ): Promise<void> {
    for (const item of snapshot.items) {
      await this.upsertItem(manager, item, snapshot.snapshotRevision);
    }
    const keptIds = snapshot.items.map((item) => item.menuItemId);
    await manager
      .getRepository(CatalogItemEntity)
      .createQueryBuilder()
      .update(CatalogItemEntity)
      .set({ active: false, appliedRevision: snapshot.snapshotRevision, updatedAt: now })
      .where(keptIds.length > 0 ? 'menu_item_id NOT IN (:...keptIds)' : 'true', { keptIds })
      .execute();
    await this.advanceCheckpoint(manager, outletId, snapshot.snapshotRevision, now, snapshot.snapshotId);
  }

  private async advanceCheckpoint(
    manager: EntityManager,
    outletId: string,
    lastAppliedRevision: string,
    now: Date,
    snapshotId?: string,
  ): Promise<void> {
    await manager
      .getRepository(MenuSyncStateEntity)
      .createQueryBuilder()
      .update(MenuSyncStateEntity)
      .set({
        lastAppliedRevision,
        lastSyncAt: now,
        ...(snapshotId ? { snapshotId } : {}),
      })
      .where('outlet_id = :outletId', { outletId })
      .execute();
  }
}
