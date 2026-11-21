import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { OutletKeyGuard } from '../../common/auth/outlet-key.guard.js';
import { EventsController } from './events.controller.js';
import { EventIngestService } from './event-ingest.service.js';
import { MenuPullController } from './menu-pull.controller.js';
import { MenuPullRepository } from './menu-pull.repository.js';
import { MenuSyncService } from './menu-sync.service.js';
import { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import { SyncInboxRepository } from './sync-inbox.repository.js';

/**
 * Machine sync surface (PRD §7.4): menu pull and event batch ingest today;
 * checkpoint, heartbeat and the HQ-side sync-status projection grow here in
 * Phase 3. The `OutletKeyGuard` is module-scoped — human JWT routes are
 * unaffected (§9.2: sync routes never accept browser credentials).
 */
@Module({
  imports: [ApiKeysModule],
  controllers: [MenuPullController, EventsController],
  providers: [
    OutletKeyGuard,
    MenuPullRepository,
    MenuSyncService,
    SyncInboxRepository,
    SyncCheckpointRepository,
    EventIngestService,
  ],
})
export class SyncIngestModule {}
