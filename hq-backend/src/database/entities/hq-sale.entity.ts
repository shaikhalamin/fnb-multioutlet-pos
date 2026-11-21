import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable accepted-sale projection (PRD §6.1, §8.1): written in the same HQ
 * transaction as its inbox row, stores exactly what the event carried — never
 * recomputed from today's catalog (AT-19). Reporting reads this table only.
 */
@Entity({ name: 'hq_sales' })
// `uq_hq_sale_source`/`uq_hq_receipt` (plain unique indexes) and the partial
// reporting index `idx_hq_sales_reporting (outlet_id, sold_at) WHERE status =
// 'COMPLETED'` are migration-owned.
@Index('idx_hq_sales_ingested', ['outletId', 'ingestedAt'])
export class HqSaleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** The outlet's local `sales.id`; dedupe key for replays. */
  @Column({ name: 'source_sale_id', type: 'uuid' })
  sourceSaleId!: string;

  @Column({ name: 'receipt_no', type: 'text' })
  receiptNo!: string;

  @Column({ name: 'sold_at', type: 'timestamptz' })
  soldAt!: Date;

  /** Total in integer minor units, `bigint` (TS string). */
  @Column({ name: 'total_minor', type: 'bigint' })
  totalMinor!: string;

  @Column({ name: 'currency_code', type: 'text' })
  currencyCode!: string;

  @Column({ name: 'status', type: 'text' })
  status!: string;

  @CreateDateColumn({ name: 'ingested_at', type: 'timestamptz' })
  ingestedAt!: Date;
}
