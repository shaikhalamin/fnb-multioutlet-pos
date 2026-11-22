import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MenuPullConsumer } from './consumers/menu-pull.consumer.js';
import { OutboxDispatchConsumer } from './consumers/outbox-dispatch.consumer.js';
import { SyncDeliveryConsumer } from './consumers/sync-delivery.consumer.js';
import { SyncReconcileConsumer } from './consumers/sync-reconcile.consumer.js';
import { SyncSchedulerService } from './consumers/sync-scheduler.service.js';
import { QUEUES } from './processors/queue-names.js';
import { SyncModule } from './sync.module.js';

/**
 * Worker-only BullMQ wiring (PRD §13): registers the four sync queues, their
 * consumers and the repeatable scheduler. Composed in by `WorkerAppModule` —
 * never imported by the API `AppModule`, so the API process keeps zero
 * BullMQ/Redis connections and the sale path stays outage-proof (AT-10).
 */
@Module({
  imports: [
    SyncModule,
    BullModule.registerQueue(
      { name: QUEUES.menuPull },
      { name: QUEUES.outboxDispatch },
      { name: QUEUES.syncDelivery },
      { name: QUEUES.syncReconcile },
    ),
  ],
  providers: [
    OutboxDispatchConsumer,
    SyncDeliveryConsumer,
    MenuPullConsumer,
    SyncReconcileConsumer,
    SyncSchedulerService,
  ],
})
export class SyncWorkerModule {}
