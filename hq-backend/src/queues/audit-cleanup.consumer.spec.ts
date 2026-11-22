import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { JsonLogger } from '../common/logging/logger.service.js';
import type { AuditRetentionService } from '../modules/audit/audit-retention.service.js';
import { AuditCleanupConsumer } from './audit-cleanup.consumer.js';
import { JOB_NAMES } from './queue-names.js';

function makeJob(name: string): Job {
  return { name, data: {} } as Job;
}

function makeRetention() {
  return { runOnce: vi.fn() } as unknown as AuditRetentionService;
}

describe('AuditCleanupConsumer.process', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(JsonLogger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(JsonLogger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs one retention pass and logs the sweep summary for the scheduled job name', async () => {
    const retention = makeRetention();
    retention.runOnce.mockResolvedValue({ deleted: 3, cutoff: new Date('2026-08-22T12:00:00.000Z') });
    const consumer = new AuditCleanupConsumer(retention);

    await consumer.process(makeJob(JOB_NAMES.auditCleanup));

    expect(retention.runOnce).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('audit_retention_sweep', {
      deleted: 3,
      cutoff: '2026-08-22T12:00:00.000Z',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ignores unknown job names (the queue has one contract)', async () => {
    const retention = makeRetention();
    const consumer = new AuditCleanupConsumer(retention);

    await consumer.process(makeJob('something-else'));

    expect(retention.runOnce).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('performs no sweep log when retention is disabled (null result)', async () => {
    const retention = makeRetention();
    retention.runOnce.mockResolvedValue(null);
    const consumer = new AuditCleanupConsumer(retention);

    await consumer.process(makeJob(JOB_NAMES.auditCleanup));

    expect(retention.runOnce).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs structurally and never kills the worker when the pass fails', async () => {
    const retention = makeRetention();
    retention.runOnce.mockRejectedValue(new Error('database unavailable'));
    const consumer = new AuditCleanupConsumer(retention);

    await expect(consumer.process(makeJob(JOB_NAMES.auditCleanup))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('audit_retention_failed', { error: 'database unavailable' });
  });
});
