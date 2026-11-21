import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * On-hand quantity per assigned catalog item (PRD §6.2): PK is the local
 * catalog item; `CHECK (quantity_on_hand >= 0)` (`inventory_nonnegative`) is
 * the final stock floor. `version` bumps on every mutation and is guarded by
 * row locks inside the mutation transaction (root AGENTS §3.4).
 */
@Entity({ name: 'inventory_balances' })
export class InventoryBalanceEntity {
  @PrimaryColumn({ name: 'menu_item_id', type: 'uuid' })
  menuItemId!: string;

  /** Signed-safe on-hand count, `bigint` (TS string). */
  @Column({ name: 'quantity_on_hand', type: 'bigint' })
  quantityOnHand!: string;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
