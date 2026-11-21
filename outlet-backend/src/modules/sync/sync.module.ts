import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/**
 * Sync-facing surface (PRD §7.3): local status today; the Phase-3 worker
 * (menu pull, outbox dispatch, reconciliation) grows here.
 */
@Module({
  imports: [OutboxModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
