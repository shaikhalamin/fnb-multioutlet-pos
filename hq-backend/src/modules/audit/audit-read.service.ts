import { Injectable } from '@nestjs/common';
import type { AuditLogEntity } from '../../database/entities/audit-log.entity.js';
import type { AuditLogResponse, ListAuditLogsQuery } from './dto/audit.dto.js';
import { AuditLogsRepository } from './audit.repository.js';

/** Page size clamp: ≤ 100 rows per request, 50 by default. */
export const MAX_AUDIT_PAGE_SIZE = 100;
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * Read side of the audit trail (PRD §11 audit views): read-only, cursor-
 * paginated listing. Rows are immutable — this service never writes.
 */
@Injectable()
export class AuditReadService {
  constructor(private readonly logs: AuditLogsRepository) {}

  async list(query: ListAuditLogsQuery): Promise<{ rows: AuditLogResponse[]; nextCursor: string | undefined }> {
    const decoded = decodeCursor(query.cursor);
    const page = await this.logs.list({
      limit: query.limit ?? DEFAULT_AUDIT_PAGE_SIZE,
      action: query.action,
      actorId: query.actorId,
      entityId: query.entityId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: decoded,
    });
    return { rows: page.rows.map(toAuditLogResponse), nextCursor: page.nextCursor };
  }
}

function decodeCursor(raw: string | undefined): { occurredAt: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      occurredAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') return undefined;
    return parsed as { occurredAt: string; id: string };
  } catch {
    return undefined;
  }
}

function toAuditLogResponse(row: AuditLogEntity): AuditLogResponse {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: row.metadata,
    occurredAt: row.occurredAt.toISOString(),
  };
}
