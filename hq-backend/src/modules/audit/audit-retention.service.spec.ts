import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_RETENTION_BATCH_SIZE } from './audit-retention.service.js';
import { AuditRetentionService } from './audit-retention.service.js';
import type { AuditLogsRepository } from './audit.repository.js';
import type { Env } from '../../config/env.schema.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function makeService(retentionDays: number, deleted = 0) {
  const config = { get: vi.fn().mockReturnValue(retentionDays) };
  const deleteExpiredBatchBefore = vi.fn().mockResolvedValue(deleted);
  const logs = { deleteExpiredBatchBefore } as unknown as AuditLogsRepository;
  const service = new AuditRetentionService(
    logs,
    config as unknown as ConfigService<Env, true>,
  );
  return { service, deleteExpiredBatchBefore };
}

describe('AuditRetentionService.runOnce', () => {
  it('performs no deletes when retention is disabled (default 0 — immutable trail)', async () => {
    const { service, deleteExpiredBatchBefore } = makeService(0);
    expect(await service.runOnce(NOW)).toBeNull();
    expect(deleteExpiredBatchBefore).not.toHaveBeenCalled();
  });

  it('computes the cutoff exactly retentionDays before now and delegates one bounded batch', async () => {
    const { service, deleteExpiredBatchBefore } = makeService(90, 3);
    const result = await service.runOnce(NOW);
    expect(result?.deleted).toBe(3);
    expect(result?.cutoff.toISOString()).toBe(new Date('2026-08-22T12:00:00.000Z').toISOString());
    expect(deleteExpiredBatchBefore).toHaveBeenCalledTimes(1);
    expect(deleteExpiredBatchBefore).toHaveBeenCalledWith(
      new Date('2026-08-22T12:00:00.000Z'),
      AUDIT_RETENTION_BATCH_SIZE,
    );
  });

  it('pins the pass bound to the plan-documented 1000 rows', () => {
    expect(AUDIT_RETENTION_BATCH_SIZE).toBe(1000);
  });
});
