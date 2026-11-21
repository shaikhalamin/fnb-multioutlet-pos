import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletAuditLogEntity, type OutletAuditActorType } from '../../database/entities/outlet-audit-log.entity.js';

export type OutletAuditEvent = {
  actorType: OutletAuditActorType;
  actorId?: string | null;
  action: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Outlet-local audit trail (PRD §8.8): privileged sync actions — the
 * emergency grace override, quarantine alerts, quarantine replay — are
 * recorded where the action happened, with the acting identity.
 */
@Injectable()
export class OutletAuditService {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /** Appends an immutable audit row; joins the caller's transaction when one is given. */
  async record(event: OutletAuditEvent, manager?: EntityManager): Promise<void> {
    const repository = manager
      ? manager.getRepository(OutletAuditLogEntity)
      : this.dataSource.getRepository(OutletAuditLogEntity);
    const row = repository.create({
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      action: event.action,
      entityId: event.entityId ?? null,
      metadata: event.metadata ?? {},
    });
    // jsonb column typing is a deep-partial mismatch for TypeORM's insert;
    // the row shape is exact by construction.
    await repository.insert(row as never);
  }

  /** Latest audit row for an action (e.g. the active grace override). */
  async findLatest(action: string): Promise<OutletAuditLogEntity | null> {
    return this.dataSource.getRepository(OutletAuditLogEntity).findOne({
      where: { action },
      order: { occurredAt: 'DESC' },
    });
  }
}
