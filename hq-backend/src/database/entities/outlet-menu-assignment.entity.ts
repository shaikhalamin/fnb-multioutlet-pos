import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Effective (outlet, item) assignment; UNIQUE(outlet_id, menu_item_id) — at
 * most one effective row per pair; `active = false` is the soft-unassign
 * tombstone and history is never hard-deleted (FR-02). Effective price =
 * `priceOverrideMinor ?? item default` in integer minor units (bigint).
 */
@Entity({ name: 'outlet_menu_assignments' })
export class OutletMenuAssignmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  /** Nullable override in integer minor units, `bigint`. */
  @Column({ name: 'price_override_minor', type: 'bigint', nullable: true })
  priceOverrideMinor!: string | null;

  @Column({ name: 'active', type: 'boolean' })
  active!: boolean;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
