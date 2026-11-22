import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { JsonLogger } from '../../../common/logging/logger.service.js';
// Value import (not `import type`): the class is an injection token.
import { SyncDeliveryProcessor } from '../processors/sync-delivery.processor.js';
import { QUEUES } from '../processors/queue-names.js';

/**
 * BullMQ consumer for `sync-delivery` (PRD §8.5–§8.6): loads the durable
 * outbox rows behind the job's event IDs and pushes them to HQ in bounded
 * batches. Row-level retry eligibility is owned by the outbox table, not by
 * this consumer (AGENTS.md rule 12).
 */
@Processor(QUEUES.syncDelivery, { concurrency: 1 })
export class SyncDeliveryConsumer extends WorkerHost {
  private readonly logger = new JsonLogger('OUTLET-Worker');

  constructor(private readonly delivery: SyncDeliveryProcessor) {
    super();
  }

  async process(job: Job<{ eventIds?: string[] }>): Promise<void> {
    const eventIds = job.data.eventIds ?? [];
    const outcome = await this.delivery.deliver(eventIds);
    if (outcome.delivered + outcome.retried + outcome.quarantined > 0) {
      this.logger.log('sync_delivery_batch', { ...outcome });
    }
  }
}
