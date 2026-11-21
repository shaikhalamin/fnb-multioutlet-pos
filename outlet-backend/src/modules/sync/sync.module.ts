import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { HqSyncClient } from './clients/hq-sync.client.js';
import { MenuApplyRepository } from './repositories/menu-apply.repository.js';
import { MenuPullService } from './services/menu-pull.service.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/**
 * Sync-facing surface (PRD §7.3, §8): local status reads, the Phase-3 menu
 * pull/apply service and the typed HQ machine client. Delivery processors
 * (BullMQ) register on the worker entrypoint, not here.
 */
@Module({
  imports: [OutboxModule],
  controllers: [SyncController],
  providers: [SyncService, HqSyncClient, MenuApplyRepository, MenuPullService],
})
export class SyncModule {}
