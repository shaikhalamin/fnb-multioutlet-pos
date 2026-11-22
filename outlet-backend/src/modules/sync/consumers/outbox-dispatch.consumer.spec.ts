import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import type { OutboxSweepProcessor } from '../processors/outbox-sweep.processor.js';
import type { SyncHeartbeatProcessor } from '../processors/sync-reconcile.processor.js';
import { JOB_NAMES } from '../processors/queue-names.js';
import { OutboxDispatchConsumer } from './outbox-dispatch.consumer.js';

function makeJob(name: string): Job {
  return { name, data: {} } as Job;
}

function makeConsumer(sweepResult: string[] = []) {
  const sweep = vi.fn().mockResolvedValue(sweepResult);
  const beat = vi.fn().mockResolvedValue(true);
  const add = vi.fn().mockResolvedValue(undefined);
  const consumer = new OutboxDispatchConsumer(
    { sweep } as unknown as OutboxSweepProcessor,
    { beat } as unknown as SyncHeartbeatProcessor,
    { add } as unknown as Queue,
  );
  return { consumer, sweep, beat, add };
}

describe('OutboxDispatchConsumer.process', () => {
  beforeEach(() => {
    vi.spyOn(JsonLogger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueues leased event IDs on sync-delivery with capped exponential retries', async () => {
    const { consumer, sweep, add } = makeConsumer(['event-1', 'event-2']);

    await consumer.process(makeJob(JOB_NAMES.sweep));

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      JOB_NAMES.deliver,
      { eventIds: ['event-1', 'event-2'] },
      { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
    );
  });

  it('enqueues nothing when the sweep finds no due events', async () => {
    const { consumer, add } = makeConsumer([]);

    await consumer.process(makeJob(JOB_NAMES.sweep));

    expect(add).not.toHaveBeenCalled();
  });

  it('reports the backlog heartbeat without touching the sweeper', async () => {
    const { consumer, sweep, beat, add } = makeConsumer(['event-1']);

    await consumer.process(makeJob(JOB_NAMES.heartbeat));

    expect(beat).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('ignores unknown job names (the queue has one contract)', async () => {
    const { consumer, sweep, beat, add } = makeConsumer(['event-1']);

    await consumer.process(makeJob('something-else'));

    expect(sweep).not.toHaveBeenCalled();
    expect(beat).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
