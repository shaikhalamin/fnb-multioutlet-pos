import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { OutletKeyGuard } from '../../common/auth/outlet-key.guard.js';
import { SyncEventsController } from './events.controller.js';
import { EventIngestService } from './event-ingest.service.js';
import { HqSyncStatusService } from './hq-sync-status.service.js';
import { MenuPullController } from './menu-pull.controller.js';
import { MenuPullRepository } from './menu-pull.repository.js';
import { MenuSyncService } from './menu-sync.service.js';
import { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import { SyncInboxRepository } from './sync-inbox.repository.js';
import { SyncAdminController } from './sync-admin.controller.js';
import { SyncStatusController } from './sync-status.controller.js';

/**
 * Machine sync surface (PRD §7.4): menu pull, event batch ingest, checkpoint
 * and heartbeat. The `OutletKeyGuard` is module-scoped — human JWT routes are
 * unaffected (§9.2: sync routes never accept browser credentials). The HQ
 * sync-status projection is exported for the human outlets surface (FR-10).
 */
@Module({
  imports: [ApiKeysModule],
  controllers: [MenuPullController, SyncEventsController, SyncStatusController, SyncAdminController],
  providers: [
    OutletKeyGuard,
    MenuPullRepository,
    MenuSyncService,
    SyncInboxRepository,
    SyncCheckpointRepository,
    EventIngestService,
    HqSyncStatusService,
  ],
  exports: [HqSyncStatusService],
})
export class SyncIngestModule {}
