import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { HqSyncClient } from './clients/hq-sync.client.js';
import { MenuPullProcessor } from './processors/menu-pull.processor.js';
import { OutboxSweepProcessor } from './processors/outbox-sweep.processor.js';
import { SyncDeliveryProcessor } from './processors/sync-delivery.processor.js';
import { SyncHeartbeatProcessor, SyncReconcileProcessor } from './processors/sync-reconcile.processor.js';
import { MenuApplyRepository } from './repositories/menu-apply.repository.js';
import { MenuPullService } from './services/menu-pull.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/**
 * Sync-facing surface (PRD §7.3, §8): local status reads, the Phase-3 menu
 * pull/apply service, the typed HQ machine client and the dispatcher
 * processors. BullMQ queue/worker instances are plain providers wired on the
 * worker entrypoint (`worker-main.ts`), never part of the sale path.
 */
@Module({
  imports: [OutboxModule, AuditModule],
  controllers: [SyncController],
  providers: [
    SyncService,
    HqSyncClient,
    MenuApplyRepository,
    MenuPullService,
    OutboxSweepProcessor,
    SyncDeliveryProcessor,
    MenuPullProcessor,
    SyncReconcileProcessor,
    SyncHeartbeatProcessor,
  ],
})
export class SyncModule {}
