import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { HqSyncStatusService } from './hq-sync-status.service.js';
import type { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import type { SyncInboxRepository } from './sync-inbox.repository.js';

const OUTLET_A = '11111111-1111-4111-8111-111111111111';

function makeService(
  checkpoint: Record<string, unknown> | null,
  sequences: string[],
  revision = '42',
  outletExists = true,
) {
  const checkpoints = {
    find: vi.fn().mockResolvedValue(checkpoint),
    upsertHeartbeat: vi.fn().mockResolvedValue(undefined),
  };
  const inbox = { listSequences: vi.fn().mockResolvedValue(sequences) };
  // First getRepository call resolves the outlet entity, the second the
  // catalog revision row (order matches the service's Promise.all setup).
  const dataSource = {
    getRepository: vi
      .fn()
      .mockReturnValueOnce({ findOne: vi.fn().mockResolvedValue(outletExists ? { id: OUTLET_A } : null) })
      .mockReturnValue({ findOne: vi.fn().mockResolvedValue(revision ? { currentRevision: revision } : null) }),
  };
  const service = new HqSyncStatusService(
    dataSource as unknown as DataSource,
    checkpoints as unknown as SyncCheckpointRepository,
    inbox as unknown as SyncInboxRepository,
  );
  return { service, checkpoints, inbox };
}

describe('HqSyncStatusService.getCheckpoint', () => {
  it('reports no missing ranges when sequences are contiguous', async () => {
    const { service } = makeService({ highestContiguousSequence: '3' }, ['1', '2', '3']);
    const checkpoint = await service.getCheckpoint(OUTLET_A);
    expect(checkpoint).toEqual({
      outletId: OUTLET_A,
      highestContiguousSequence: '3',
      missingRanges: [],
    });
  });

  it('reports each gap above the watermark as a missing range (AT-21 shape)', async () => {
    const { service } = makeService({ highestContiguousSequence: '5' }, [
      '1',
      '2',
      '3',
      '4',
      '5',
      '8',
      '9',
      '12',
    ]);
    const checkpoint = await service.getCheckpoint(OUTLET_A);
    expect(checkpoint.highestContiguousSequence).toBe('5');
    expect(checkpoint.missingRanges).toEqual([
      { from: '6', to: '7' },
      { from: '10', to: '11' },
    ]);
  });

  it('defaults to watermark 0 and no ranges for a never-seen outlet', async () => {
    const { service } = makeService(null, []);
    const checkpoint = await service.getCheckpoint(OUTLET_A);
    expect(checkpoint.highestContiguousSequence).toBe('0');
    expect(checkpoint.missingRanges).toEqual([]);
  });
});

describe('HqSyncStatusService.recordHeartbeat', () => {
  it('upserts the backlog snapshot + menu revision and acknowledges', async () => {
    const now = new Date('2026-11-20T04:03:00.000Z');
    const { service, checkpoints } = makeService(null, []);
    const acknowledgedAt = await service.recordHeartbeat(
      OUTLET_A,
      { appliedMenuRevision: '41', pendingOutboxCount: 3, quarantinedCount: 1, oldestPendingAt: '2026-11-20T04:00:00.000Z' },
      now,
    );
    expect(acknowledgedAt).toBe(now.toISOString());
    expect(checkpoints.upsertHeartbeat).toHaveBeenCalledWith(
      OUTLET_A,
      { pendingOutboxCount: 3, quarantinedCount: 1, oldestPendingAt: '2026-11-20T04:00:00.000Z' },
      '41',
      now,
    );
  });

  it('normalizes a missing oldestPendingAt to null', async () => {
    const { service, checkpoints } = makeService(null, []);
    await service.recordHeartbeat(OUTLET_A, { appliedMenuRevision: '0', pendingOutboxCount: 0, quarantinedCount: 0 }, new Date());
    expect(checkpoints.upsertHeartbeat).toHaveBeenCalledWith(
      OUTLET_A,
      { pendingOutboxCount: 0, quarantinedCount: 0, oldestPendingAt: null },
      '0',
      expect.any(Date),
    );
  });
});

describe('HqSyncStatusService.getOutletSyncStatus', () => {
  it('maps the checkpoint + backlog into the human projection (FR-10)', async () => {
    const { service } = makeService(
      {
        outletId: OUTLET_A,
        highestContiguousSequence: '108',
        lastEventAt: new Date('2026-11-20T04:02:10.000Z'),
        lastHeartbeatAt: new Date('2026-11-20T04:03:00.000Z'),
        lastMenuSeenRevision: '42',
        lastReportedBacklog: { pendingOutboxCount: 2, quarantinedCount: 1, oldestPendingAt: '2026-11-20T04:00:00.000Z' },
      },
      [],
      '42',
    );
    const status = await service.getOutletSyncStatus(OUTLET_A);
    expect(status).toEqual({
      outletId: OUTLET_A,
      currentMenuRevision: '42',
      highestContiguousSequence: '108',
      lastEventAt: '2026-11-20T04:02:10.000Z',
      lastHeartbeatAt: '2026-11-20T04:03:00.000Z',
      lastMenuSeenRevision: '42',
      lastReportedBacklog: {
        pendingOutboxCount: 2,
        quarantinedCount: 1,
        oldestPendingAt: '2026-11-20T04:00:00.000Z',
      },
      quarantinedCount: 1,
    });
  });

  it('renders null watermarks for an outlet that never synced (stale ≠ zero)', async () => {
    const { service } = makeService(null, [], '0');
    const status = await service.getOutletSyncStatus(OUTLET_A);
    expect(status.currentMenuRevision).toBe('0');
    expect(status.lastEventAt).toBeNull();
    expect(status.lastReportedBacklog).toBeNull();
    expect(status.quarantinedCount).toBe(0);
  });

  it('404s for an outlet that does not exist', async () => {
    const { service } = makeService(null, [], '0', false);
    await expect(service.getOutletSyncStatus(OUTLET_A)).rejects.toMatchObject({ status: 404 });
  });
});
