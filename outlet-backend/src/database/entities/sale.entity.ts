import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SaleStatus = 'COMPLETED';

/**
 * Completed local sale header (PRD §6.2): totals/receipt/`sold_at` are always
 * server-computed; `(outlet_id, receipt_number)` and `(outlet_id, receipt_no)`
 * are unique. `syncStatus` is deliberately NOT a column — it is resolved from
 * the outbox row (PRD §8.7: sale status and sync status are separate).
 */
@Entity({ name: 'sales' })
@Index('idx_sales_sold_at', ['soldAt'])
export class SaleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** Numeric counter the receipt was allocated from, `bigint` (TS string). */
  @Column({ name: 'receipt_number', type: 'bigint' })
  receiptNumber!: string;

  /** Display receipt, e.g. `A-000001`. */
  @Column({ name: 'receipt_no', type: 'text' })
  receiptNo!: string;

  @Column({ name: 'total_minor', type: 'bigint' })
  totalMinor!: string;

  @Column({ name: 'currency_code', type: 'text' })
  currencyCode!: string;

  @Column({ name: 'status', type: 'text' })
  status!: SaleStatus;

  /** Local catalog revision the sale was priced against (`bigint`, string). */
  @Column({ name: 'catalog_revision', type: 'bigint' })
  catalogRevision!: string;

  @Column({ name: 'sold_at', type: 'timestamptz' })
  soldAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
