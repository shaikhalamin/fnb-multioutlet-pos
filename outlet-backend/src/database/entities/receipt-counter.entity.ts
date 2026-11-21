import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Singleton per-outlet receipt counter (PRD §6.2): the sale transaction
 * locks this row `FOR UPDATE`, increments `next_number`, and derives the
 * display receipt `A-000001` from the prefix. `CHECK (next_number > 0)`.
 */
@Entity({ name: 'receipt_counters' })
export class ReceiptCounterEntity {
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'next_number', type: 'bigint' })
  nextNumber!: string;

  @Column({ name: 'prefix', type: 'text' })
  prefix!: string;
}
