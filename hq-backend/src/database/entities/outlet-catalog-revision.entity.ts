import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One locked row per outlet holding its per-outlet catalog revision; menu
 * mutations lock it `FOR UPDATE`, increment, and append a change row inside
 * the same transaction (PRD §6.1, §8.2). `bigint` revision mapped as string.
 */
@Entity({ name: 'outlet_catalog_revisions' })
export class OutletCatalogRevisionEntity {
  @PrimaryColumn({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'current_revision', type: 'bigint' })
  currentRevision!: string;
}
