import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Singleton row describing this terminal's HQ connection (PRD §8.7, §9.2):
 * the HQ sync base URL plus the machine key issued by HQ and saved through
 * the setup wizard (or rotated through the authenticated sync surface). The
 * raw secret must exist to authenticate outbound sync calls — it lives only
 * in this outlet-owned database and is never serialized to any client,
 * never logged, and never echoed back by an API response.
 */
@Entity({ name: 'hq_connection' })
export class HqConnectionEntity {
  /** FK to `outlet_identity`: the connection exists only once identity does. */
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'hq_base_url', type: 'text' })
  hqBaseUrl!: string;

  /** Non-secret key identifier; safe to display (e.g. `ok_live_…`). */
  @Column({ name: 'key_id', type: 'text' })
  keyId!: string;

  /** Raw machine-key secret — outlet-owned credential, never exposed. */
  @Column({ name: 'key_secret', type: 'text' })
  keySecret!: string;

  /** When HQ last accepted this key (validated at save/rotate time). */
  @Column({ name: 'last_validated_at', type: 'timestamptz' })
  lastValidatedAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
