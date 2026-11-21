import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { HqSaleEntity } from './hq-sale.entity.js';

/**
 * Immutable accepted-sale line projection (PRD §6.1, §8.1): name/price
 * snapshots exactly as sold; a later HQ price change never rewrites these
 * (FR-02, AT-19).
 */
@Entity({ name: 'hq_sale_items' })
@Index('idx_hq_sale_items_item', ['menuItemId', 'hqSaleId'])
export class HqSaleItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'hq_sale_id', type: 'uuid' })
  hqSaleId!: string;

  @ManyToOne(() => HqSaleEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'hq_sale_id' })
  sale!: HqSaleEntity;

  /** The outlet's local `sale_items.id`. */
  @Column({ name: 'source_sale_item_id', type: 'uuid' })
  sourceSaleItemId!: string;

  /** HQ master-menu UUID as captured by the outlet at sale time. */
  @Column({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  @Column({ name: 'name_snapshot', type: 'text' })
  nameSnapshot!: string;

  @Column({ name: 'quantity', type: 'integer' })
  quantity!: number;

  /** Price in integer minor units, `bigint` (TS string). */
  @Column({ name: 'unit_price_minor', type: 'bigint' })
  unitPriceMinor!: string;

  /** Subtotal in integer minor units, `bigint` (TS string). */
  @Column({ name: 'subtotal_minor', type: 'bigint' })
  subtotalMinor!: string;
}
