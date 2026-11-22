import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import type { Env } from '../../../config/env.schema.js';
import { JOB_NAMES, REPEAT_JOB_IDS } from '../processors/queue-names.js';
import { SyncSchedulerService } from './sync-scheduler.service.js';

const INTERVALS = {
  MENU_PULL_INTERVAL_MS: 30_000,
  OUTBOX_SWEEP_INTERVAL_MS: 5_000,
  HEARTBEAT_INTERVAL_MS: 60_000,
  SYNC_RECONCILE_INTERVAL_MS: 3_600_000,
};

function makeService() {
  const calls: { queue: string; args: unknown[] }[] = [];
  const makeQueue = (name: string): Queue =>
    ({
      upsertJobScheduler: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ queue: name, args });
        return Promise.resolve(undefined);
      }),
    }) as unknown as Queue;
  const dispatchQueue = makeQueue('outbox-dispatch');
  const deliveryQueue = makeQueue('sync-delivery');
  const menuPullQueue = makeQueue('menu-pull');
  const reconcileQueue = makeQueue('sync-reconcile');
  const config = { get: vi.fn((key: string) => INTERVALS[key as keyof typeof INTERVALS]) };
  const service = new SyncSchedulerService(
    dispatchQueue,
    deliveryQueue,
    menuPullQueue,
    reconcileQueue,
    config as unknown as ConfigService<Env, true>,
  );
  return { service, calls };
}

describe('SyncSchedulerService.registerWithRetry', () => {
  it('registers the four repeatable schedulers with fixed jobIds and bounded history', async () => {
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, calls } = makeService();

    await service.registerWithRetry();

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.queue)).toEqual([
      'outbox-dispatch',
      'outbox-dispatch',
      'menu-pull',
      'sync-reconcile',
    ]);
    expect(calls[0]?.args).toEqual([
      REPEAT_JOB_IDS.sweep,
      { every: 5_000 },
      { name: JOB_NAMES.sweep, data: {}, opts: { removeOnComplete: { count: 20 } } },
    ]);
    expect(calls[1]?.args).toEqual([
      REPEAT_JOB_IDS.heartbeat,
      { every: 60_000 },
      { name: JOB_NAMES.heartbeat, data: {}, opts: { removeOnComplete: { count: 20 } } },
    ]);
    expect(calls[2]?.args).toEqual([
      REPEAT_JOB_IDS.pull,
      { every: 30_000 },
      { name: JOB_NAMES.pull, data: {}, opts: { removeOnComplete: { count: 20 } } },
    ]);
    expect(calls[3]?.args).toEqual([
      REPEAT_JOB_IDS.reconcile,
      { every: 3_600_000 },
      { name: JOB_NAMES.reconcile, data: {}, opts: { removeOnComplete: { count: 20 } } },
    ]);
    vi.restoreAllMocks();
  });

  it('stops retrying once the module is destroyed', async () => {
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(() => undefined);
    let rejectFirst!: (error: Error) => void;
    const upsertJobScheduler = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockRejectedValue(new Error('redis unavailable'));
    const queue = { upsertJobScheduler } as unknown as Queue;
    const config = { get: vi.fn().mockReturnValue(1) }; // 1ms retry sleep
    const service = new SyncSchedulerService(queue, queue, queue, queue, config as unknown as ConfigService<Env, true>);

    const pending = service.registerWithRetry();
    await vi.waitFor(() => expect(upsertJobScheduler).toHaveBeenCalledTimes(1));
    rejectFirst(new Error('redis unavailable'));
    service.onModuleDestroy();
    await pending;

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
