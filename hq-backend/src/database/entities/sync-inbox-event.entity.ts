import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * HQ inbox deduplication record (PRD §6.1, §8.5–§8.6): one immutable row per
 * accepted event, keyed by `(outletId, eventId)` and `(outletId, sequenceNo)`
 * with the canonical payload hash. Redelivery of the same bytes resolves to
 * `DUPLICATE` from this row; identity reuse with a different payload is a
 * permanent conflict and never overwrites the original.
 */
@Entity({ name: 'sync_inbox_events' })
export class SyncInboxEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** Equals the outlet outbox row ID (`event_id = id`, PRD §8.4). */
  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  /** Per-outlet contiguous sequence (`bigint`, TS string). */
  @Column({ name: 'sequence_no', type: 'bigint' })
  sequenceNo!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  /** SHA-256 over the canonical JSON payload. */
  @Column({ name: 'payload_sha256', type: 'text' })
  payloadSha256!: string;

  @Column({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number;

  /** Only accepted events persist; rejects/duplicates never insert a row. */
  @Column({ name: 'status', type: 'text' })
  status!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
