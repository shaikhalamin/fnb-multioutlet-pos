import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Singleton menu-sync checkpoint (PRD §6.2, §8.3): the atomic record of the
 * last applied HQ revision. `last_sync_at` also anchors the offline grace
 * policy (PRD §8.8) — a stale timestamp past `OFFLINE_GRACE_HOURS` blocks
 * new sales.
 */
@Entity({ name: 'menu_sync_state' })
export class MenuSyncStateEntity {
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  /** Last HQ revision fully applied locally (`bigint`, TS string). */
  @Column({ name: 'last_applied_revision', type: 'bigint' })
  lastAppliedRevision!: string;

  @Column({ name: 'last_sync_at', type: 'timestamptz' })
  lastSyncAt!: Date;

  /** Snapshot the catalog was last rebuilt from, when applicable. */
  @Column({ name: 'snapshot_id', type: 'uuid', nullable: true })
  snapshotId!: string | null;
}
