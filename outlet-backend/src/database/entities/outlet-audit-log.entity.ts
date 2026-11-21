import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type OutletAuditActorType = 'USER' | 'SYSTEM';

/**
 * Outlet-local operations audit (PRD §8.8): privileged actions such as the
 * emergency offline-grace override and quarantine replay must be audited at
 * the site that performed them (HQ's audit log cannot see outlet actors).
 */
@Entity({ name: 'outlet_audit_logs' })
@Index('idx_outlet_audit_logs_occurred', ['occurredAt'])
export class OutletAuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_type', type: 'text' })
  actorType!: OutletAuditActorType;

  /** Null when the actor is the system (schedulers, workers). */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ name: 'action', type: 'text' })
  action!: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId!: string | null;

  @Column({ name: 'metadata', type: 'jsonb' })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
