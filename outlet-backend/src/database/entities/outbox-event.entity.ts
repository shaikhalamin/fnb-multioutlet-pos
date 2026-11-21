import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OutboxStatus = 'PENDING' | 'RETRY' | 'DELIVERED' | 'QUARANTINED';

/**
 * Transactional-outbox row (PRD §6.2, §8.4–§8.6): written in the same local
 * transaction as the sale; `id` doubles as the sync `eventId`. The Phase-2
 * sale path inserts `PENDING` rows only — the dispatcher worker lands in
 * Phase 3.
 */
@Entity({ name: 'outbox_events' })
// `idx_outbox_due` (partial: PENDING/RETRY) and the jsonb expression index
// `idx_outbox_sale_id ((payload->'data'->>'saleId'))` are migration-owned —
// they cannot be expressed as column decorators.
@Index('idx_outbox_due', ['status', 'nextAttemptAt'])
export class OutboxEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** Per-outlet contiguous sequence (`bigint`, TS string). */
  @Column({ name: 'sequence_no', type: 'bigint' })
  sequenceNo!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number;

  /** Full sync-event payload per `contracts/sync-event-v1.schema.json`. */
  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** SHA-256 over the canonical JSON payload. */
  @Column({ name: 'payload_sha256', type: 'text' })
  payloadSha256!: string;

  @Column({ name: 'status', type: 'text' })
  status!: OutboxStatus;

  @Column({ name: 'attempts', type: 'integer' })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'lease_until', type: 'timestamptz', nullable: true })
  leaseUntil!: Date | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
