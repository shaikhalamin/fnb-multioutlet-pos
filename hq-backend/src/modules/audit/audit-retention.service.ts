import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { AuditLogsRepository } from './audit.repository.js';

/** One bounded batch per timer pass — the hourly tick drains gradually. */
export const AUDIT_RETENTION_BATCH_SIZE = 1000;

export type AuditRetentionResult = { deleted: number; cutoff: Date };

/**
 * Audit retention (PRD FR-10 lifecycle): deletes expired audit rows in
 * bounded batches. `AUDIT_LOG_RETENTION_DAYS = 0` (the default) disables
 * deletion entirely — the trail is immutable out of the box; enabling
 * retention is a deliberate operator decision.
 */
@Injectable()
export class AuditRetentionService {
  constructor(
    private readonly logs: AuditLogsRepository,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async runOnce(now = new Date()): Promise<AuditRetentionResult | null> {
    const retentionDays = this.config.get('AUDIT_LOG_RETENTION_DAYS', { infer: true });
    if (!retentionDays || retentionDays <= 0) return null;

    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.logs.deleteExpiredBatchBefore(cutoff, AUDIT_RETENTION_BATCH_SIZE);
    return { deleted, cutoff };
  }
}
