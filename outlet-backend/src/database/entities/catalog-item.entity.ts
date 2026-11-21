import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Local read-model of the outlet's assigned catalog (PRD §6.2): upserted by
 * HQ ID by the menu sync (Phase 3). Identity is the HQ `menu_item_id`;
 * price/status are updated only by sync — never by a sale.
 */
@Entity({ name: 'catalog_items' })
export class CatalogItemEntity {
  /** HQ master-menu-item UUID; the local primary key. */
  @PrimaryColumn({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  /** HQ outlet-menu-assignment UUID captured from the applied change. */
  @Column({ name: 'assignment_id', type: 'uuid' })
  assignmentId!: string;

  @Column({ name: 'sku', type: 'text' })
  sku!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  @Column({ name: 'category', type: 'text' })
  category!: string;

  /** Effective outlet price in integer minor units, `bigint` (TS string). */
  @Column({ name: 'effective_price_minor', type: 'bigint' })
  effectivePriceMinor!: string;

  @Column({ name: 'currency_code', type: 'text' })
  currencyCode!: string;

  @Column({ name: 'active', type: 'boolean' })
  active!: boolean;

  /** HQ item `version` at the time the change was applied. */
  @Column({ name: 'hq_item_version', type: 'integer' })
  hqItemVersion!: number;

  /** Catalog revision this row was last applied at (`bigint`, TS string). */
  @Column({ name: 'applied_revision', type: 'bigint' })
  appliedRevision!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
