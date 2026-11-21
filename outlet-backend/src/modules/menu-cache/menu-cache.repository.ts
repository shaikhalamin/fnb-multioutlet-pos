import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { CatalogItemEntity } from '../../database/entities/catalog-item.entity.js';
import { MenuSyncStateEntity } from '../../database/entities/menu-sync-state.entity.js';

/** One active catalog row joined with its live stock figure. */
export type MenuItemWithStock = {
  menuItemId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  effectivePriceMinor: string;
  currencyCode: string;
  /** `bigint` sums arrive as strings from pg; missing balance ⇒ '0'. */
  availableQuantity: string;
};

/**
 * Read model over the local catalog cache (PRD §6.2, §7.3): the POS menu is
 * active catalog items LEFT JOINed with inventory balances — an item never
 * sold yet shows 0, an item with no balance row also shows 0.
 */
@Injectable()
export class MenuCacheRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async findActiveItemsWithStock(): Promise<MenuItemWithStock[]> {
    return this.dataSource
      .createQueryBuilder()
      .select('item.menu_item_id', 'menuItemId')
      .addSelect('item.sku', 'sku')
      .addSelect('item.name', 'name')
      .addSelect('item.description', 'description')
      .addSelect('item.category', 'category')
      .addSelect('item.effective_price_minor', 'effectivePriceMinor')
      .addSelect('item.currency_code', 'currencyCode')
      .addSelect('COALESCE(balance.quantity_on_hand, 0)', 'availableQuantity')
      .from(CatalogItemEntity, 'item')
      .leftJoin('inventory_balances', 'balance', 'balance.menu_item_id = item.menu_item_id')
      .where('item.active = true')
      .orderBy('item.category', 'ASC')
      .addOrderBy('item.name', 'ASC')
      .getRawMany<MenuItemWithStock>();
  }

  /** The singleton menu-sync checkpoint (PRD §6.2). */
  async getSyncState(): Promise<MenuSyncStateEntity | null> {
    return this.dataSource.getRepository(MenuSyncStateEntity).findOne({ where: {} });
  }
}
