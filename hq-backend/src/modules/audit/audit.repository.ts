import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { AuditLogEntity } from '../../database/entities/audit-log.entity.js';

export type AuditLogFilter = {
  limit: number;
  action?: string;
  actorId?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  cursor?: { occurredAt: string; id: string };
};

/**
 * Read side of the immutable audit trail (PRD §11 audit views). Ordering is
 * `occurred_at DESC, id DESC` — the (timestamp, id) keyset makes pagination
 * stable under concurrent writes: newer rows land above the cursor and never
 * shift an in-flight walk.
 */
@Injectable()
export class AuditLogsRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(filter: AuditLogFilter): Promise<{ rows: AuditLogEntity[]; nextCursor: string | undefined }> {
    const query = this.dataSource
      .getRepository(AuditLogEntity)
      .createQueryBuilder('log')
      .orderBy('log.occurredAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .take(filter.limit + 1);
    if (filter.action) query.andWhere('log.action = :action', { action: filter.action });
    if (filter.actorId) query.andWhere('log.actorId = :actorId', { actorId: filter.actorId });
    if (filter.entityId) query.andWhere('log.entityId = :entityId', { entityId: filter.entityId });
    if (filter.from) query.andWhere('log.occurredAt >= :from', { from: filter.from });
    if (filter.to) query.andWhere('log.occurredAt < :to', { to: filter.to });
    if (filter.cursor) {
      query.andWhere('(log.occurredAt, log.id) < (:occurredAt, :id)', {
        occurredAt: new Date(filter.cursor.occurredAt),
        id: filter.cursor.id,
      });
    }

    const rows = await query.getMany();
    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt.toISOString(), id: last.id }), 'utf8').toString(
              'base64url',
            )
          : undefined,
    };
  }
}
