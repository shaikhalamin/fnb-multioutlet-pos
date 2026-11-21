import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type StockMovementReason = 'SALE' | 'RESTOCK' | 'WRITE_OFF' | 'RECOUNT';

/**
 * Append-only audited stock ledger (PRD §6.2, FR-04): every balance change
 * records a signed `delta_quantity` with its reason, the originating sale
 * (if any), the acting local user, the request ID, and `occurred_at`.
 */
@Entity({ name: 'stock_movements' })
@Index('idx_stock_movements_item_time', ['menuItemId', 'occurredAt'])
export class StockMovementEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  /** Signed delta, `bigint` (TS string): negative for sales/write-offs. */
  @Column({ name: 'delta_quantity', type: 'bigint' })
  deltaQuantity!: string;

  @Column({ name: 'reason', type: 'text' })
  reason!: StockMovementReason;

  @Column({ name: 'source_sale_id', type: 'uuid', nullable: true })
  sourceSaleId!: string | null;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  /** `X-Request-Id` of the request that produced this movement (FR-04). */
  @Column({ name: 'request_id', type: 'text', nullable: true })
  requestId!: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
