import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
// Value import (not `import type`): the class is an injection token.
import { MenuPullProcessor } from '../processors/menu-pull.processor.js';
import { QUEUES } from '../processors/queue-names.js';

/**
 * BullMQ consumer for `menu-pull` (PRD §8.3, FR-05): pulls catalog changes
 * from HQ on the repeatable cadence and applies them atomically with the
 * checkpoint advance. Pull failures are logged inside the processor and
 * never take the outlet offline.
 */
@Processor(QUEUES.menuPull, { concurrency: 1 })
export class MenuPullConsumer extends WorkerHost {
  constructor(private readonly menuPull: MenuPullProcessor) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.menuPull.pull();
  }
}
