import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletCatalogRevisionEntity } from '../../database/entities/outlet-catalog-revision.entity.js';
import { OutletEntity } from '../../database/entities/outlet.entity.js';
import type {
  HeartbeatRequest,
  OutletSyncStatusResponse,
  SequenceRange,
  SyncCheckpointResponse,
} from './dto/sync-status.dto.js';
// Value imports (not `import type`): classes are injection tokens.
import { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import { SyncInboxRepository } from './sync-inbox.repository.js';

/** Hard bound on the missing-range scan (bounded queries, PRD §15). */
const MAX_SEQUENCE_SCAN = 100_000;

/**
 * HQ-side sync watermarks (PRD §7.4, §8.7): the outlet-facing checkpoint
 * (reconciliation input) and heartbeat persistence, plus the projection
 * behind the human `GET /outlets/:id/sync-status` (FR-10).
 */
@Injectable()
export class HqSyncStatusService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly checkpoints: SyncCheckpointRepository,
    private readonly inbox: SyncInboxRepository,
  ) {}

  async getCheckpoint(outletId: string): Promise<SyncCheckpointResponse> {
    const checkpoint = await this.checkpoints.find(outletId);
    const highest = BigInt(checkpoint?.highestContiguousSequence ?? '0');
    const sequences = (await this.inbox.listSequences(outletId, MAX_SEQUENCE_SCAN)).map(BigInt);

    // Gaps between the contiguous watermark and accepted-but-isolated events.
    const missingRanges: SequenceRange[] = [];
    let cursor = highest;
    for (const sequence of sequences) {
      if (sequence > cursor + 1n) {
        missingRanges.push({ from: (cursor + 1n).toString(), to: (sequence - 1n).toString() });
      }
      if (sequence > cursor) {
        cursor = sequence;
      }
    }
    return {
      outletId,
      highestContiguousSequence: highest.toString(),
      missingRanges,
    };
  }

  async recordHeartbeat(outletId: string, request: HeartbeatRequest, now = new Date()): Promise<string> {
    await this.checkpoints.upsertHeartbeat(
      outletId,
      {
        pendingOutboxCount: request.pendingOutboxCount,
        quarantinedCount: request.quarantinedCount,
        oldestPendingAt: request.oldestPendingAt ?? null,
      },
      request.appliedMenuRevision,
      now,
    );
    return now.toISOString();
  }

  /** Projection for `GET /outlets/:id/sync-status` (FR-10). */
  async getOutletSyncStatus(outletId: string): Promise<OutletSyncStatusResponse> {
    const outlet = await this.dataSource.getRepository(OutletEntity).findOne({ where: { id: outletId } });
    if (!outlet) {
      throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    }
    const [revision, checkpoint] = await Promise.all([
      this.dataSource
        .getRepository(OutletCatalogRevisionEntity)
        .findOne({ where: { outletId } })
        .then((row) => row?.currentRevision ?? '0'),
      this.checkpoints.find(outletId),
    ]);
    const backlog = checkpoint?.lastReportedBacklog ?? null;
    return {
      outletId,
      currentMenuRevision: revision,
      highestContiguousSequence: checkpoint?.highestContiguousSequence ?? '0',
      lastEventAt: checkpoint?.lastEventAt?.toISOString() ?? null,
      lastHeartbeatAt: checkpoint?.lastHeartbeatAt?.toISOString() ?? null,
      lastMenuSeenRevision: checkpoint?.lastMenuSeenRevision ?? null,
      lastReportedBacklog: backlog
        ? {
            pendingOutboxCount: Number(backlog.pendingOutboxCount ?? 0),
            quarantinedCount: Number(backlog.quarantinedCount ?? 0),
            oldestPendingAt:
              typeof backlog.oldestPendingAt === 'string' ? backlog.oldestPendingAt : null,
          }
        : null,
      quarantinedCount: Number(backlog?.quarantinedCount ?? 0),
    };
  }
}
