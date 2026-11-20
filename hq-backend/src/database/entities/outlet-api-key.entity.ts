import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type OutletApiKeyStatus = 'ACTIVE' | 'REVOKED';

/**
 * Machine credential used by the outlet sync worker (Phase 3) —
 * `Authorization: OutletKey <keyId>.<secret>`. Only a peppered HMAC digest of
 * the secret is stored; rotation keeps the predecessor ACTIVE until its
 * `expires_at` overlap elapses (PRD §6.1, §9.2).
 */
@Entity({ name: 'outlet_api_keys' })
export class OutletApiKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'key_id', type: 'text' })
  keyId!: string;

  @Column({ name: 'outlet_id', type: 'uuid' })
  outletId!: string;

  @Column({ name: 'secret_hash', type: 'text' })
  secretHash!: string;

  @Column({ name: 'scopes', type: 'text', array: true })
  scopes!: string[];

  @Column({ name: 'status', type: 'text' })
  status!: OutletApiKeyStatus;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'rotated_from_id', type: 'uuid', nullable: true })
  rotatedFromId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
