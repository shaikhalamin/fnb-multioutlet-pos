import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-outlet sync watermark (PRD §6.1): the highest **contiguous** accepted
 * event sequence (gaps never advance it — AT-21), heartbeat-reported backlog,
 * and the menu revision the outlet last reported applying. Feeds
 * reconciliation, `GET /outlets/:id/sync-status` and staleness alerts.
 */
@Entity({ name: 'sync_outlet_checkpoints' })
export class SyncOutletCheckpointEntity {
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** Highest contiguous accepted sequence (`bigint`, TS string). */
  @Column({ name: 'highest_contiguous_sequence', type: 'bigint', default: '0' })
  highestContiguousSequence!: string;

  @Column({ name: 'last_event_at', type: 'timestamptz', nullable: true })
  lastEventAt!: Date | null;

  /** Last heartbeat backlog payload (`pendingOutboxCount`, etc.), jsonb. */
  @Column({ name: 'last_reported_backlog', type: 'jsonb', nullable: true })
  lastReportedBacklog!: Record<string, unknown> | null;

  /** Menu revision the outlet last reported applying (`bigint`, TS string). */
  @Column({ name: 'last_menu_seen_revision', type: 'bigint', nullable: true })
  lastMenuSeenRevision!: string | null;

  @Column({ name: 'last_heartbeat_at', type: 'timestamptz', nullable: true })
  lastHeartbeatAt!: Date | null;
}
