import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
// Value import (not `import type`): the class is an injection token.
import { SyncReconcileProcessor } from '../processors/sync-reconcile.processor.js';
import { QUEUES } from '../processors/queue-names.js';

/**
 * BullMQ consumer for `sync-reconcile` (PRD §8.7): compares HQ's
 * contiguous-sequence watermark against the local outbox and re-leases
 * missing-range events. Reconciliation failure is logged, never fatal.
 */
@Processor(QUEUES.syncReconcile, { concurrency: 1 })
export class SyncReconcileConsumer extends WorkerHost {
  constructor(private readonly reconciler: SyncReconcileProcessor) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.reconciler.reconcile();
  }
}
