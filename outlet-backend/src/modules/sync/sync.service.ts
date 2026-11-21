import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MenuSyncStateEntity } from '../../database/entities/menu-sync-state.entity.js';
import { OutletIdentityEntity } from '../../database/entities/outlet-identity.entity.js';
import { OutletAuditService } from '../audit/outlet-audit.service.js';
// Value import (not `import type`): the class is an injection token.
import { OutboxRepository } from '../outbox/outbox.repository.js';
import type {
  ExtendGraceRequest,
  GraceOverrideResponse,
  ReplayOutboxEventResponse,
  SyncStatusResponse,
} from './dto/sync.dto.js';

/**
 * Local sync status + privileged sync actions (PRD §7.3, §8.5, §8.8).
 * Status reads are answered entirely from this outlet's own tables — no HQ
 * call is ever made (an outlet's status read never depends on HQ
 * reachability, PRD §2, §8.1). The emergency grace override and quarantine
 * replay are manager-only and audited.
 */
@Injectable()
export class SyncService {
  private readonly offlineGraceHours: number;
  private readonly outletId: string;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly audit: OutletAuditService,
    config: ConfigService<Env, true>,
  ) {
    this.offlineGraceHours = config.get('OFFLINE_GRACE_HOURS', { infer: true });
    this.outletId = config.get('OUTLET_ID', { infer: true });
  }

  async getStatus(): Promise<SyncStatusResponse> {
    const identityRepo = this.dataSource.getRepository(OutletIdentityEntity);
    const syncStateRepo = this.dataSource.getRepository(MenuSyncStateEntity);
    const [identity, syncState, counts, oldestPendingAt, lastPublishedAt, quarantinedSample] = await Promise.all([
      identityRepo.findOne({ where: { outletId: this.outletId } }),
      syncStateRepo.findOne({ where: {} }),
      this.outbox.countByStatus(),
      this.outbox.oldestPendingAt(),
      this.outbox.lastPublishedAt(),
      this.outbox.findQuarantinedSample(),
    ]);

    // Effective grace expiry = max(window from last sync, active override) —
    // the same computation the sale path enforces (PRD §8.8).
    const override = await this.activeOverride(syncState?.graceOverriddenUntil ?? null);
    const windowExpiry = syncState?.lastSyncAt
      ? syncState.lastSyncAt.getTime() + this.offlineGraceHours * 3_600_000
      : null;
    const effective = Math.max(windowExpiry ?? Number.NEGATIVE_INFINITY, override ? Date.parse(override.until) : Number.NEGATIVE_INFINITY);
    const graceExpiresAt = Number.isFinite(effective) ? new Date(effective) : null;

    return {
      outletId: this.outletId,
      outletCode: identity?.outletCode ?? '',
      lastAppliedRevision: syncState?.lastAppliedRevision ?? '0',
      lastMenuSyncAt: syncState?.lastSyncAt?.toISOString() ?? null,
      grace: {
        hours: this.offlineGraceHours,
        expiresAt: graceExpiresAt?.toISOString() ?? null,
        expired: graceExpiresAt ? Date.now() > graceExpiresAt.getTime() : true,
        override,
      },
      outbox: {
        pendingCount: counts.PENDING + counts.RETRY,
        quarantinedCount: counts.QUARANTINED,
        oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
        lastPublishedAt: lastPublishedAt?.toISOString() ?? null,
        lastErrorSample:
          quarantinedSample.length > 0
            ? quarantinedSample.map((sample) => ({
                eventId: sample.id,
                sequenceNo: sample.sequenceNo,
                lastError: sample.lastError,
              }))
            : null,
      },
    };
  }

  /**
   * Emergency offline-grace override (PRD §8.8): privileged + audited. The
   * new expiry and its audit row commit in ONE transaction — a crash between
   * them can never silently extend the window.
   */
  async extendGrace(
    request: ExtendGraceRequest,
    actor: { id: string; email: string },
  ): Promise<GraceOverrideResponse> {
    const until = new Date(Date.now() + request.hours * 3_600_000);
    await this.dataSource.transaction(async (manager) => {
      const updated = await manager
        .getRepository(MenuSyncStateEntity)
        .createQueryBuilder()
        .update(MenuSyncStateEntity)
        .set({ graceOverriddenUntil: until })
        .where('outlet_id = :outletId', { outletId: this.outletId })
        .execute();
      if ((updated.affected ?? 0) === 0) {
        throw new ApiException('NOT_FOUND', 'Menu sync state missing for this outlet.', 404);
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorId: actor.id,
          action: 'sync.grace_override',
          entityId: this.outletId,
          metadata: {
            hours: request.hours,
            reason: request.reason,
            until: until.toISOString(),
            actorEmail: actor.email,
          },
        },
        manager,
      );
    });
    return { until: until.toISOString(), hours: request.hours };
  }

  /**
   * Manual repair/replay for a quarantined event (PRD §8.5): re-arms the row
   * to PENDING after operator review. The re-arm and its audit row commit in
   * ONE transaction — a crash between them can never leave a privileged
   * replay un-audited (same atomicity as the grace override).
   */
  async replayQuarantinedEvent(
    eventId: string,
    actor: { id: string },
  ): Promise<ReplayOutboxEventResponse> {
    await this.dataSource.transaction(async (manager) => {
      const replayed = await this.outbox.replayQuarantined(manager, eventId);
      if (!replayed) {
        const existing = await manager.query<Array<{ status: string }>>(
          'SELECT status FROM outbox_events WHERE id = $1',
          [eventId],
        );
        if (existing.length === 0) {
          throw new ApiException('NOT_FOUND', 'Outbox event not found.', 404);
        }
        throw new ApiException('CONFLICT', `Only QUARANTINED events can be replayed (status: ${existing[0].status}).`, 409, {
          eventId,
          status: existing[0].status,
        });
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorId: actor.id,
          action: 'sync.quarantine_replayed',
          entityId: eventId,
          metadata: {},
        },
        manager,
      );
    });
    return { eventId, status: 'PENDING' };
  }

  /** The override display: the latest audit row, while still in force. */
  private async activeOverride(until: Date | null) {
    if (!until || Date.now() > until.getTime()) return null;
    const latest = await this.audit.findLatest('sync.grace_override');
    if (!latest) return null;
    return {
      active: true,
      until: until.toISOString(),
      reason: String(latest.metadata.reason ?? ''),
      overriddenBy: String(latest.actorId ?? ''),
    };
  }
}
