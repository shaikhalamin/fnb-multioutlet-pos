import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import type { DeliveryOutcome, SyncDeliveryProcessor } from '../processors/sync-delivery.processor.js';
import { SyncDeliveryConsumer } from './sync-delivery.consumer.js';

function makeJob(data: { eventIds?: string[] }): Job<{ eventIds?: string[] }> {
  return { name: 'sync-deliver', data } as Job<{ eventIds?: string[] }>;
}

function makeConsumer(outcome: DeliveryOutcome) {
  const deliver = vi.fn().mockResolvedValue(outcome);
  const consumer = new SyncDeliveryConsumer({ deliver } as unknown as SyncDeliveryProcessor);
  return { consumer, deliver };
}

describe('SyncDeliveryConsumer.process', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(JsonLogger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers the job event IDs and logs a non-empty outcome', async () => {
    const { consumer, deliver } = makeConsumer({ delivered: 2, retried: 1, quarantined: 0 });

    await consumer.process(makeJob({ eventIds: ['event-1', 'event-2', 'event-3'] }));

    expect(deliver).toHaveBeenCalledWith(['event-1', 'event-2', 'event-3']);
    expect(logSpy).toHaveBeenCalledWith('sync_delivery_batch', { delivered: 2, retried: 1, quarantined: 0 });
  });

  it('treats missing event IDs as an empty batch and stays silent on a no-op', async () => {
    const { consumer, deliver } = makeConsumer({ delivered: 0, retried: 0, quarantined: 0 });

    await consumer.process(makeJob({}));

    expect(deliver).toHaveBeenCalledWith([]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
