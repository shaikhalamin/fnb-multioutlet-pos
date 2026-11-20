import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per issued refresh JWT, keyed on its `jti` claim (PRD §6.1, §9.1).
 * Rotation inserts a successor row with the same `family_id` and stamps
 * `rotated_at` on the predecessor; presenting an already-rotated or unknown
 * `jti` revokes the whole family.
 */
@Entity({ name: 'hq_refresh_sessions' })
@Index('idx_hq_refresh_sessions_user', ['userId'])
@Index('idx_hq_refresh_sessions_family', ['familyId'])
export class HqRefreshSessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'family_id', type: 'uuid' })
  familyId!: string;

  @Column({ name: 'jti', type: 'uuid' })
  jti!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
