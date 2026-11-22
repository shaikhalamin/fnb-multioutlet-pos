import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { JsonLogger } from '../common/logging/logger.service.js';
import type { Env } from '../config/env.schema.js';
import { JOB_NAMES, REPEAT_JOB_IDS } from './queue-names.js';
import { QueuesSchedulerService } from './queues-scheduler.service.js';

function makeService(env: Record<string, number>) {
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const queue = { upsertJobScheduler } as unknown as Queue;
  const config = { get: vi.fn((key: string) => env[key]) };
  const service = new QueuesSchedulerService(queue, config as unknown as ConfigService<Env, true>);
  return { service, upsertJobScheduler };
}

describe('QueuesSchedulerService.registerWithRetry', () => {
  it('registers the repeatable audit-cleanup scheduler with a fixed jobId', async () => {
    const { service, upsertJobScheduler } = makeService({ AUDIT_RETENTION_CHECK_MS: 3_600_000 });

    await service.registerWithRetry();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      REPEAT_JOB_IDS.auditCleanup,
      { every: 3_600_000 },
      { name: JOB_NAMES.auditCleanup, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
  });

  it('retries registration against the same queue until it succeeds', async () => {
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, upsertJobScheduler } = makeService({
      AUDIT_RETENTION_CHECK_MS: 3_600_000,
      HEARTBEAT_INTERVAL_MS: 1, // 1ms retry sleep — keeps the test instant
    });
    upsertJobScheduler.mockRejectedValueOnce(new Error('redis unavailable'));

    await service.registerWithRetry();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(upsertJobScheduler).toHaveBeenLastCalledWith(
      REPEAT_JOB_IDS.auditCleanup,
      { every: 3_600_000 },
      { name: JOB_NAMES.auditCleanup, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    vi.restoreAllMocks();
  });

  it('stops retrying once the module is destroyed', async () => {
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, upsertJobScheduler } = makeService({ HEARTBEAT_INTERVAL_MS: 1 });
    let rejectFirst!: (error: Error) => void;
    upsertJobScheduler.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFirst = reject; }),
    );
    upsertJobScheduler.mockRejectedValue(new Error('redis unavailable'));

    const pending = service.registerWithRetry();
    await vi.waitFor(() => expect(upsertJobScheduler).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('redis unavailable'));
    service.onModuleDestroy();
    await pending;

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
