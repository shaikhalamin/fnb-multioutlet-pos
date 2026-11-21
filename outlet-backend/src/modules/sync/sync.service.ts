import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletIdentityEntity } from '../../database/entities/outlet-identity.entity.js';
import { MenuSyncStateEntity } from '../../database/entities/menu-sync-state.entity.js';
import type { Env } from '../../config/env.schema.js';
// Value import (not `import type`): the class is an injection token.
import { OutboxRepository } from '../outbox/outbox.repository.js';
import type { SyncStatusResponse } from './dto/sync.dto.js';

/**
 * Local sync status (PRD §7.3 `GET /sync/status`): everything is answered
 * from this outlet's own tables — menu checkpoint, grace window state and
 * outbox backlog. No HQ call is ever made (an outlet's status read never
 * depends on HQ reachability, PRD §2, §8.1).
 */
@Injectable()
export class SyncService {
  private readonly offlineGraceHours: number;
  private readonly outletId: string;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    config: ConfigService<Env, true>,
  ) {
    this.offlineGraceHours = config.get('OFFLINE_GRACE_HOURS', { infer: true });
    this.outletId = config.get('OUTLET_ID', { infer: true });
  }

  async getStatus(): Promise<SyncStatusResponse> {
    const identityRepo = this.dataSource.getRepository(OutletIdentityEntity);
    const syncStateRepo = this.dataSource.getRepository(MenuSyncStateEntity);
    const [identity, syncState, counts, oldestPendingAt, lastPublishedAt] = await Promise.all([
      identityRepo.findOne({ where: { outletId: this.outletId } }),
      syncStateRepo.findOne({ where: {} }),
      this.outbox.countByStatus(),
      this.outbox.oldestPendingAt(),
      this.outbox.lastPublishedAt(),
    ]);

    const lastMenuSyncAt = syncState?.lastSyncAt ?? null;
    const graceExpiresAt = lastMenuSyncAt
      ? new Date(lastMenuSyncAt.getTime() + this.offlineGraceHours * 3_600_000)
      : null;

    return {
      outletId: this.outletId,
      outletCode: identity?.outletCode ?? '',
      lastAppliedRevision: syncState?.lastAppliedRevision ?? '0',
      lastMenuSyncAt: lastMenuSyncAt?.toISOString() ?? null,
      grace: {
        hours: this.offlineGraceHours,
        expiresAt: graceExpiresAt?.toISOString() ?? null,
        expired: graceExpiresAt ? Date.now() >= graceExpiresAt.getTime() : true,
      },
      outbox: {
        pendingCount: counts.PENDING,
        quarantinedCount: counts.QUARANTINED,
        oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
        lastPublishedAt: lastPublishedAt?.toISOString() ?? null,
      },
    };
  }
}
