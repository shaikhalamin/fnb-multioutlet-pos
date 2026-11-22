import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { CatalogItemEntity } from '../../database/entities/catalog-item.entity.js';
import { InventoryBalanceEntity } from '../../database/entities/inventory-balance.entity.js';
import { StockMovementEntity } from '../../database/entities/stock-movement.entity.js';

/**
 * Catalog item joined with its balance (when one exists) for the inventory
 * view. Items never stocked yet surface with `quantityOnHand` '0' and
 * `version` 0 — the catalog row is the anchor, not the balance row.
 */
export type InventoryRow = {
  menuItemId: string;
  name: string;
  sku: string;
  quantityOnHand: string;
  version: number;
  updatedAt: Date;
};

/**
 * Inventory balances + the append-only stock ledger (PRD §6.2, FR-04/FR-05).
 * Mutation methods take the caller's transaction manager and lock the
 * balance row `FOR UPDATE` before reading it (root AGENTS §3.4).
 */
@Injectable()
export class InventoryRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * One row per local catalog item, LEFT JOINed with its balance: an item
   * that has never been stocked still appears (quantity 0, version 0) so the
   * inventory view can offer the audited first-restock adjustment (PRD §8.8
   * bootstrapping — same COALESCE convention as the POS menu read in
   * menu-cache.repository). Inactive items keep showing: their balances and
   * history remain after HQ removes the assignment.
   */
  async listBalances(): Promise<InventoryRow[]> {
    return this.dataSource
      .createQueryBuilder()
      .select('item.menu_item_id', 'menuItemId')
      .addSelect('item.name', 'name')
      .addSelect('item.sku', 'sku')
      .addSelect('COALESCE(balance.quantity_on_hand, 0)', 'quantityOnHand')
      .addSelect('COALESCE(balance.version, 0)', 'version')
      .addSelect('COALESCE(balance.updated_at, item.updated_at)', 'updatedAt')
      .from(CatalogItemEntity, 'item')
      .leftJoin('inventory_balances', 'balance', 'balance.menu_item_id = item.menu_item_id')
      .orderBy('item.name', 'ASC')
      .getRawMany<InventoryRow>();
  }

  /** Catalog existence check (adjustments on unknown items are rejected). */
  async catalogItemExists(menuItemId: string): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(CatalogItemEntity)
      .count({ where: { menuItemId } });
    return count > 0;
  }

  /**
   * Locks the balance row `FOR UPDATE` inside the caller's transaction.
   * Returns null when no balance row exists yet (item never stocked).
   */
  async lockBalance(
    manager: EntityManager,
    menuItemId: string,
  ): Promise<InventoryBalanceEntity | null> {
    return manager
      .getRepository(InventoryBalanceEntity)
      .createQueryBuilder('balance')
      .setLock('pessimistic_write')
      .where('balance.menu_item_id = :menuItemId', { menuItemId })
      .getOne();
  }

  /** Upsert for items with no balance row yet (first restock of a new item). */
  async insertBalance(
    manager: EntityManager,
    input: { menuItemId: string; quantityOnHand: string },
  ): Promise<InventoryBalanceEntity> {
    const repo = manager.getRepository(InventoryBalanceEntity);
    return repo.save(
      repo.create({
        menuItemId: input.menuItemId,
        quantityOnHand: input.quantityOnHand,
        version: 1,
      }),
    );
  }

  /** Bumps `version` on every mutation; caller holds the row lock. */
  async updateBalance(
    manager: EntityManager,
    menuItemId: string,
    quantityOnHand: string,
    version: number,
  ): Promise<InventoryBalanceEntity> {
    const repo = manager.getRepository(InventoryBalanceEntity);
    await repo.update({ menuItemId }, { quantityOnHand, version, updatedAt: new Date() });
    const updated = await this.lockBalance(manager, menuItemId);
    if (!updated) throw new Error(`balance row vanished mid-transaction: ${menuItemId}`);
    return updated;
  }

  async appendMovement(
    manager: EntityManager,
    movement: {
      menuItemId: string;
      deltaQuantity: string;
      reason: StockMovementEntity['reason'];
      sourceSaleId: string | null;
      actorId: string | null;
      requestId: string | null;
      occurredAt: Date;
    },
  ): Promise<void> {
    const repo = manager.getRepository(StockMovementEntity);
    await repo.insert(repo.create(movement));
  }
}
