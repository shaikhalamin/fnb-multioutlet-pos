import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OutboxEventEntity } from './outbox-event.entity.js';

/**
 * Append-only delivery attempt ledger (PRD §6.2): one row per send attempt —
 * HTTP status, duration and stable error code. Debugging/retention-limited
 * audit; never contains secrets or full payloads.
 */
@Entity({ name: 'sync_attempt_logs' })
@Index('idx_sync_attempt_logs_event', ['outboxEventId', 'attemptAt'])
export class SyncAttemptLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outbox_event_id', type: 'uuid' })
  outboxEventId!: string;

  @ManyToOne(() => OutboxEventEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'outbox_event_id' })
  event!: OutboxEventEntity;

  /** HTTP status of the send attempt; null for transport-level failures. */
  @Column({ name: 'status_code', type: 'integer', nullable: true })
  statusCode!: number | null;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  /** Stable error code (e.g. `EVENT_ID_CONFLICT`, `ECONNREFUSED`); null on success. */
  @Column({ name: 'error_code', type: 'text', nullable: true })
  errorCode!: string | null;

  @CreateDateColumn({ name: 'attempt_at', type: 'timestamptz' })
  attemptAt!: Date;
}
