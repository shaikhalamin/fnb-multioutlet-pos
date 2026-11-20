import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type CatalogChangeAction = 'UPSERT' | 'REMOVE';

/**
 * Append-only per-outlet catalog change log; UNIQUE(outlet_id, revision).
 * Each row carries the complete, reproducible outlet-effective item snapshot
 * so outlets never need to reconstruct an old delta from current state
 * (PRD §6.1, §8.2 rule 4).
 */
@Entity({ name: 'outlet_catalog_changes' })
export class OutletCatalogChangeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'revision', type: 'bigint' })
  revision!: string;

  @Column({ name: 'action', type: 'text' })
  action!: CatalogChangeAction;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
