import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type MasterMenuItemStatus = 'ACTIVE' | 'ARCHIVED';

/**
 * Master catalog item; UNIQUE(company_id, sku); immutable UUID with a status
 * tombstone instead of hard deletion; `version` bumps on every edit and is
 * echoed into outlet change payloads (FR-01, §8.3). Price is integer minor
 * units stored as `bigint` and serialized as a decimal string (PRD §1.3).
 */
@Entity({ name: 'master_menu_items' })
export class MasterMenuItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'company_id', type: 'uuid' })
  companyId!: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ name: 'sku', type: 'text' })
  sku!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  /** Integer minor units, `bigint`; TypeORM maps this to a decimal string. */
  @Column({ name: 'default_price_minor', type: 'bigint' })
  defaultPriceMinor!: string;

  @Column({ name: 'currency_code', type: 'text' })
  currencyCode!: string;

  @Column({ name: 'status', type: 'text' })
  status!: MasterMenuItemStatus;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
