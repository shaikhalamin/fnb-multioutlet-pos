import { Module } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { SyncWorkerModule } from './modules/sync/sync-worker.module.js';

/**
 * Composition root of the sync-worker entrypoint (`src/worker-main.ts`): the
 * full outlet module graph plus the worker-only BullMQ queues (PRD §13).
 * The API entrypoint boots `AppModule` directly and never imports this
 * module.
 */
@Module({
  imports: [AppModule, SyncWorkerModule],
})
export class WorkerAppModule {}
