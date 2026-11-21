import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable sale line (PRD §6.2, FR-02): name/SKU/unit price are snapshots
 * captured at sale time — a later HQ price change never rewrites a receipt.
 * Duplicate request lines are merged by `menuItemId` before insert, so
 * `(sale_id, menu_item_id)` is unique.
 */
@Entity({ name: 'sale_items' })
@Index('idx_sale_items_sale', ['saleId'])
export class SaleItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'sale_id', type: 'uuid' })
  saleId!: string;

  @Column({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  @Column({ name: 'name_snapshot', type: 'text' })
  nameSnapshot!: string;

  @Column({ name: 'sku_snapshot', type: 'text' })
  skuSnapshot!: string;

  @Column({ name: 'quantity', type: 'integer' })
  quantity!: number;

  /** Snapshot price in integer minor units, `bigint` (TS string). */
  @Column({ name: 'unit_price_minor', type: 'bigint' })
  unitPriceMinor!: string;

  @Column({ name: 'subtotal_minor', type: 'bigint' })
  subtotalMinor!: string;

  @Column({ name: 'catalog_revision', type: 'bigint' })
  catalogRevision!: string;
}
