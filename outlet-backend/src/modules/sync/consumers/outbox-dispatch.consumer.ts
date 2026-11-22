import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
// Value imports (not `import type`): classes are injection tokens.
import { OutboxSweepProcessor } from '../processors/outbox-sweep.processor.js';
import { SyncHeartbeatProcessor } from '../processors/sync-reconcile.processor.js';
import { JOB_NAMES, QUEUES } from '../processors/queue-names.js';

/**
 * BullMQ consumer for `outbox-dispatch` (PRD §13): the repeatable sweep scans
 * the outbox for due events and enqueues only their IDs on `sync-delivery`;
 * the repeatable heartbeat reports backlog/menu revision to HQ. Jobs carry
 * event IDs only — no credentials, no payload-heavy sale details.
 */
@Processor(QUEUES.outboxDispatch, { concurrency: 1 })
export class OutboxDispatchConsumer extends WorkerHost {
  constructor(
    private readonly sweeper: OutboxSweepProcessor,
    private readonly heartbeat: SyncHeartbeatProcessor,
    @InjectQueue(QUEUES.syncDelivery) private readonly deliveryQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOB_NAMES.sweep) {
      const eventIds = await this.sweeper.sweep();
      if (eventIds.length > 0) {
        await this.deliveryQueue.add(
          JOB_NAMES.deliver,
          { eventIds },
          { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
        );
      }
    } else if (job.name === JOB_NAMES.heartbeat) {
      // Backlog/menu-revision report; failures are non-fatal by contract.
      await this.heartbeat.beat();
    }
  }
}
