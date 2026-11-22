import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { JsonLogger } from '../common/logging/logger.service.js';
// Value import (not `import type`): the class is an injection token.
import { AuditRetentionService } from '../modules/audit/audit-retention.service.js';
import { JOB_NAMES, QUEUES } from './queue-names.js';

/**
 * BullMQ consumer for the audit-retention sweep (FR-10): one bounded batch
 * per repeatable job. A disabled retention window (`0` days) performs no
 * deletes; a failure logs structurally and never kills the worker — the next
 * repeat job simply runs again.
 */
@Processor(QUEUES.auditCleanup, { concurrency: 1 })
export class AuditCleanupConsumer extends WorkerHost {
  private readonly logger = new JsonLogger('HQ-Worker');

  constructor(private readonly retention: AuditRetentionService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAMES.auditCleanup) {
      return; // Unknown job names are ignored — the queue has one contract.
    }
    try {
      const result = await this.retention.runOnce();
      if (result) {
        this.logger.log('audit_retention_sweep', {
          deleted: result.deleted,
          cutoff: result.cutoff.toISOString(),
        });
      }
    } catch (error) {
      this.logger.error('audit_retention_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
