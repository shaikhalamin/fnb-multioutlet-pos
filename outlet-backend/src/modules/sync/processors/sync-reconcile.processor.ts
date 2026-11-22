import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import { DATA_SOURCE } from '../../../database/database.module.js';
import { MenuSyncStateEntity } from '../../../database/entities/menu-sync-state.entity.js';
// Value imports (not `import type`): classes are injection tokens.
import { OutboxRepository } from '../../outbox/outbox.repository.js';
import { HqSyncClient, HqSyncError } from '../clients/hq-sync.client.js';

export type ReconcileSummary = {
  highestContiguousSequence: string;
  missingRanges: number;
  requeued: number;
};

/**
 * Checkpoint reconciliation (PRD §8.7): compares HQ's contiguous-sequence
 * watermark and missing ranges against the local outbox, then re-leases
 * (makes eligible) every local event inside a missing range. HQ deduplicates
 * replays, so a stale DELIVERED mark heals as a terminal DUPLICATE; events
 * are never fabricated. Reconciliation failure is logged, never fatal.
 */
@Injectable()
export class SyncReconcileProcessor {
  private readonly logger = new JsonLogger('SyncReconcile');

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly hq: HqSyncClient,
  ) {}

  async reconcile(now = new Date()): Promise<ReconcileSummary> {
    try {
      const checkpoint = await this.hq.getCheckpoint();
      const requeableIds = await this.outbox.findReleasableInRanges(checkpoint.missingRanges);
      const requeued = await this.outbox.makeEligible(requeableIds, now);
      this.logger.log('sync_reconcile_summary', {
        highestContiguousSequence: checkpoint.highestContiguousSequence,
        missingRanges: checkpoint.missingRanges.length,
        requeued,
      });
      return {
        highestContiguousSequence: checkpoint.highestContiguousSequence,
        missingRanges: checkpoint.missingRanges.length,
        requeued,
      };
    } catch (error) {
      if (error instanceof HqSyncError && error.code === 'HQ_NOT_PROVISIONED') {
        this.logger.log('awaiting_provisioning', {});
      } else if (error instanceof HqSyncError) {
        this.logger.warn('sync_reconcile_unavailable', { code: error.code, status: error.status });
      } else {
        this.logger.warn('sync_reconcile_unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { highestContiguousSequence: '-1', missingRanges: 0, requeued: 0 };
    }
  }
}

/**
 * Sync heartbeat (PRD §7.4, §13): reports the local backlog and applied menu
 * revision so HQ's `sync_outlet_checkpoints` reflects outlet-side reality.
 * Failure is non-fatal by contract.
 */
@Injectable()
export class SyncHeartbeatProcessor {
  private readonly logger = new JsonLogger('SyncHeartbeat');

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly outbox: OutboxRepository,
    private readonly hq: HqSyncClient,
  ) {}

  async beat(): Promise<boolean> {
    const syncState = await this.dataSource.getRepository(MenuSyncStateEntity).findOne({ where: {} });
    const [counts, oldestPendingAt] = await Promise.all([
      this.outbox.countByStatus(),
      this.outbox.oldestPendingAt(),
    ]);
    try {
      await this.hq.sendHeartbeat({
        appliedMenuRevision: syncState?.lastAppliedRevision ?? '0',
        pendingOutboxCount: counts.PENDING + counts.RETRY,
        quarantinedCount: counts.QUARANTINED,
        oldestPendingAt: oldestPendingAt?.toISOString() ?? null,
      });
      return true;
    } catch (error) {
      if (error instanceof HqSyncError && error.code === 'HQ_NOT_PROVISIONED') {
        this.logger.log('awaiting_provisioning', {});
      } else {
        this.logger.warn('sync_heartbeat_failed', {
          code: error instanceof HqSyncError ? error.code : 'HQ_UNREACHABLE',
        });
      }
      return false;
    }
  }
}
