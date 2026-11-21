import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { OutboxRepository } from '../../outbox/outbox.repository.js';
import type { HqSyncClient } from '../clients/hq-sync.client.js';
import { HqSyncError } from '../clients/hq-sync.client.js';
import { SyncHeartbeatProcessor, SyncReconcileProcessor } from './sync-reconcile.processor.js';

function makeReconcile(
  checkpoint: { highestContiguousSequence: string; missingRanges: Array<{ from: string; to: string }> } | Error,
  releasable: string[],
) {
  const outbox = {
    findReleasableInRanges: vi.fn().mockResolvedValue(releasable),
    makeEligible: vi.fn().mockResolvedValue(releasable.length),
    countByStatus: vi.fn(),
    oldestPendingAt: vi.fn(),
  };
  const hq = {
    getCheckpoint: vi.fn(
      checkpoint instanceof Error ? () => Promise.reject(checkpoint) : () => Promise.resolve(checkpoint),
    ),
    sendHeartbeat: vi.fn().mockResolvedValue({ acknowledgedAt: 'now' }),
  };
  const processor = new SyncReconcileProcessor(
    {} as DataSource,
    outbox as unknown as OutboxRepository,
    hq as unknown as HqSyncClient,
  );
  return { processor, outbox, hq };
}

describe('SyncReconcileProcessor', () => {
  it('re-leases local events inside HQ-reported missing ranges (§8.7)', async () => {
    const { processor, outbox } = makeReconcile(
      { highestContiguousSequence: '5', missingRanges: [{ from: '6', to: '7' }, { from: '10', to: '11' }] },
      ['e6', 'e7', 'e11'],
    );

    const summary = await processor.reconcile();
    expect(summary).toEqual({ highestContiguousSequence: '5', missingRanges: 2, requeued: 3 });
    expect(outbox.findReleasableInRanges).toHaveBeenCalledWith([
      { from: '6', to: '7' },
      { from: '10', to: '11' },
    ]);
    expect(outbox.makeEligible).toHaveBeenCalledWith(['e6', 'e7', 'e11'], expect.any(Date));
  });

  it('requeues nothing when HQ reports no gaps', async () => {
    const { processor, outbox } = makeReconcile({ highestContiguousSequence: '42', missingRanges: [] }, []);
    const summary = await processor.reconcile();
    expect(summary.requeued).toBe(0);
    expect(outbox.makeEligible).toHaveBeenCalledWith([], expect.any(Date));
  });

  it('treats HQ unavailability as non-fatal', async () => {
    const { processor } = makeReconcile(new HqSyncError('unreachable', null, 'HQ_UNREACHABLE', null), []);
    const summary = await processor.reconcile();
    expect(summary).toEqual({ highestContiguousSequence: '-1', missingRanges: 0, requeued: 0 });
  });
});

describe('SyncHeartbeatProcessor', () => {
  function makeHeartbeat(opts: {
    revision?: string;
    counts?: Record<string, number>;
    oldest?: Date | null;
    fail?: boolean;
  }) {
    const outbox = {
      countByStatus: vi.fn().mockResolvedValue(
        opts.counts ?? { PENDING: 2, RETRY: 1, DELIVERED: 10, QUARANTINED: 1 },
      ),
      oldestPendingAt: vi.fn().mockResolvedValue(opts.oldest === undefined ? new Date('2026-11-20T04:00:00Z') : opts.oldest),
    };
    const hq = {
      getCheckpoint: vi.fn(),
      sendHeartbeat: vi.fn(
        opts.fail
          ? () => Promise.reject(new HqSyncError('down', null, 'HQ_UNREACHABLE', null))
          : (payload: unknown) => Promise.resolve({ acknowledgedAt: new Date().toISOString(), payload }),
      ),
    };
    const dataSource = {
      getRepository: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue(
          opts.revision === undefined ? { lastAppliedRevision: '42' } : { lastAppliedRevision: opts.revision },
        ),
      }),
    };
    const processor = new SyncHeartbeatProcessor(
      dataSource as unknown as DataSource,
      outbox as unknown as OutboxRepository,
      hq as unknown as HqSyncClient,
    );
    return { processor, hq };
  }

  it('reports backlog + applied menu revision from local tables', async () => {
    const { processor, hq } = makeHeartbeat({});
    await expect(processor.beat()).resolves.toBe(true);
    expect(hq.sendHeartbeat).toHaveBeenCalledWith({
      appliedMenuRevision: '42',
      pendingOutboxCount: 3, // PENDING + RETRY
      quarantinedCount: 1,
      oldestPendingAt: '2026-11-20T04:00:00.000Z',
    });
  });

  it('handles a never-synced outlet with revision 0 and no backlog', async () => {
    const { processor, hq } = makeHeartbeat({ revision: '0', counts: { PENDING: 0, RETRY: 0, DELIVERED: 0, QUARANTINED: 0 }, oldest: null });
    await expect(processor.beat()).resolves.toBe(true);
    expect(hq.sendHeartbeat).toHaveBeenCalledWith({
      appliedMenuRevision: '0',
      pendingOutboxCount: 0,
      quarantinedCount: 0,
      oldestPendingAt: null,
    });
  });

  it('treats heartbeat failure as non-fatal', async () => {
    const { processor } = makeHeartbeat({ fail: true });
    await expect(processor.beat()).resolves.toBe(false);
  });
});
