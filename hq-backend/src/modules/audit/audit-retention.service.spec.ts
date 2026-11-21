import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { AUDIT_RETENTION_BATCH_SIZE } from './audit-retention.service.js';
import { AuditRetentionService } from './audit-retention.service.js';
import type { Env } from '../../config/env.schema.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function makeService(retentionDays: number, deletedRows: string[] = []) {
  const config = { get: vi.fn().mockReturnValue(retentionDays) };
  const query = vi.fn().mockResolvedValue(deletedRows.map((id) => ({ id })));
  const dataSource = { query };
  const service = new AuditRetentionService(
    dataSource as unknown as DataSource,
    config as unknown as ConfigService<Env, true>,
  );
  return { service, query, config };
}

describe('AuditRetentionService.runOnce', () => {
  it('performs no deletes when retention is disabled (default 0 — immutable trail)', async () => {
    const { service, query } = makeService(0);
    expect(await service.runOnce(NOW)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('computes the cutoff exactly retentionDays before now and deletes bounded batches', async () => {
    const { service, query } = makeService(90, ['a', 'b', 'c']);
    const result = await service.runOnce(NOW);
    expect(result?.deleted).toBe(3);
    expect(result?.cutoff.toISOString()).toBe(new Date('2026-08-22T12:00:00.000Z').toISOString());
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(`LIMIT $2`),
      [new Date('2026-08-22T12:00:00.000Z').toISOString(), AUDIT_RETENTION_BATCH_SIZE],
    );
  });

  it('bounds every pass to the batch size regardless of the expired backlog', () => {
    expect(AUDIT_RETENTION_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});
