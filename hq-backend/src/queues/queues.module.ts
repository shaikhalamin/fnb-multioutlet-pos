import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditCleanupConsumer } from './audit-cleanup.consumer.js';
import { QUEUES } from './queue-names.js';
import { QueuesSchedulerService } from './queues-scheduler.service.js';

/**
 * HQ background queues (PRD §13, worker-only): registers the `audit-cleanup`
 * BullMQ queue, its consumer and the repeatable scheduler. Composed in by
 * `WorkerAppModule` — never imported by the API `AppModule`, so the API
 * process keeps zero BullMQ connections. `AuditModule` is @Global, which is
 * how the consumer resolves `AuditRetentionService`.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.auditCleanup })],
  providers: [AuditCleanupConsumer, QueuesSchedulerService],
})
export class QueuesModule {}
