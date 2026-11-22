import { Module } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { QueuesModule } from './queues/queues.module.js';

/**
 * Composition root of the worker entrypoint (`src/worker-main.ts`): the full
 * HQ module graph plus the worker-only BullMQ queues (PRD §13). The API
 * entrypoint boots `AppModule` directly and never imports this module.
 */
@Module({
  imports: [AppModule, QueuesModule],
})
export class WorkerAppModule {}
