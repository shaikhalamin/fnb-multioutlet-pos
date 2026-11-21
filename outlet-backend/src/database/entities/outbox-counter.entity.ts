import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Singleton per-outlet event sequence allocator (PRD §6.2): locked `FOR
 * UPDATE` inside the sale transaction so `sequence_no` is contiguous and
 * duplicate-free per outlet.
 */
@Entity({ name: 'outbox_counters' })
export class OutboxCounterEntity {
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'next_sequence', type: 'bigint' })
  nextSequence!: string;
}
