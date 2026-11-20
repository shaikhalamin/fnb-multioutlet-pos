import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { AuditLogEntity, type AuditActorType } from '../../database/entities/audit-log.entity.js';

export type AuditEvent = {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends immutable operations/security audit rows (PRD §6.1, FR-10, §9.1).
 * Accepts an optional transaction manager so a mutation and its audit trail
 * commit atomically; otherwise writes on the pool directly.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async record(event: AuditEvent, manager?: EntityManager): Promise<void> {
    const repository = manager
      ? manager.getRepository(AuditLogEntity)
      : this.dataSource.getRepository(AuditLogEntity);
    const row = repository.create({
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      metadata: event.metadata ?? {},
    });
    await repository.save(row);
  }
}
