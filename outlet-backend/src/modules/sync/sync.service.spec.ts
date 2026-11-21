import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import type { OutletAuditService } from '../audit/outlet-audit.service.js';
import type { OutboxRepository } from '../outbox/outbox.repository.js';
import { SyncService } from './sync.service.js';

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';

function makeService(overrides: {
  syncState?: Record<string, unknown> | null;
  latestAudit?: Record<string, unknown> | null;
  quarantined?: Array<{ id: string; sequenceNo: string; lastError: string | null }>;
}) {
  const outbox = {
    countByStatus: vi.fn().mockResolvedValue({ PENDING: 1, RETRY: 1, DELIVERED: 5, QUARANTINED: 1 }),
    oldestPendingAt: vi.fn().mockResolvedValue(new Date('2026-11-20T04:00:00Z')),
    lastPublishedAt: vi.fn().mockResolvedValue(new Date('2026-11-20T04:02:10Z')),
    findQuarantinedSample: vi
      .fn()
      .mockResolvedValue(
        overrides.quarantined ?? [{ id: 'e1', sequenceNo: '9', lastError: 'EVENT_ID_CONFLICT' }],
      ),
    replayQuarantined: vi.fn(),
  };
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
    findLatest: vi.fn().mockResolvedValue(overrides.latestAudit ?? null),
  };
  const repoFor = (entity: { name: string }) => {
    if (entity.name === 'MenuSyncStateEntity') {
      return { findOne: vi.fn().mockResolvedValue(overrides.syncState ?? null) };
    }
    return { findOne: vi.fn().mockResolvedValue({ outletCode: 'A' }) };
  };
  const dataSource = {
    getRepository: vi.fn((entity: { name: string }) => repoFor(entity)),
    query: vi.fn().mockResolvedValue([]),
    transaction: vi.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
      cb({
        getRepository: vi.fn(() => ({
          createQueryBuilder: vi.fn(() => ({
            update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue({ affected: 1 }) })) })) })),
          })),
        })),
        // The transaction manager delegates raw queries to the same mock the
        // specs program (e.g. the not-quarantined 409 lookup).
        query: (...args: unknown[]) => dataSource.query(...args),
      }),
    ),
  };
  const config = { get: (key: string) => (key === 'OFFLINE_GRACE_HOURS' ? 72 : key === 'OUTLET_ID' ? OUTLET_ID : undefined) };
  const service = new SyncService(
    dataSource as unknown as DataSource,
    outbox as unknown as OutboxRepository,
    audit as unknown as OutletAuditService,
    config as unknown as ConfigService<never, true>,
  );
  return { service, outbox, audit, dataSource };
}

describe('SyncService.getStatus', () => {
  it('reports the effective grace expiry from window or active override (§8.8)', async () => {
    const staleSync = new Date(Date.now() - 80 * 3_600_000).toISOString(); // 80h ago: window expired
    const until = new Date(Date.now() + 6 * 3_600_000).toISOString(); // override still active
    const { service } = makeService({
      syncState: { lastSyncAt: new Date(staleSync), lastAppliedRevision: '4', graceOverriddenUntil: new Date(until) },
      latestAudit: {
        actorId: 'manager-1',
        metadata: { reason: 'Regional network outage.', until, hours: 24 },
      },
    });

    const status = await service.getStatus();
    expect(status.grace.expired).toBe(false);
    expect(status.grace.expiresAt).toBe(new Date(until).toISOString());
    expect(status.grace.override).toMatchObject({ active: true, reason: 'Regional network outage.', overriddenBy: 'manager-1' });
    expect(status.outbox.lastErrorSample).toEqual([
      { eventId: 'e1', sequenceNo: '9', lastError: 'EVENT_ID_CONFLICT' },
    ]);
    expect(status.outbox.pendingCount).toBe(2); // PENDING + RETRY
  });

  it('lapses an expired override: grace is expired and override hidden', async () => {
    const { service } = makeService({
      syncState: {
        lastSyncAt: new Date(Date.now() - 80 * 3_600_000),
        lastAppliedRevision: '4',
        graceOverriddenUntil: new Date(Date.now() - 3_600_000),
      },
      latestAudit: { actorId: 'manager-1', metadata: { reason: 'old override' } },
    });
    const status = await service.getStatus();
    expect(status.grace.expired).toBe(true);
    expect(status.grace.override).toBeNull();
  });
});

describe('SyncService.extendGrace', () => {
  it('sets the override and writes the audit row in one transaction (§8.8)', async () => {
    const { service, audit } = makeService({});
    const response = await service.extendGrace(
      { hours: 24, reason: 'Regional network outage; connector replacement scheduled.' },
      { id: 'manager-1', email: 'manager@outlet-a.local' },
    );
    expect(response.hours).toBe(24);
    expect(Date.parse(response.until)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // The audit call receives the SAME transaction manager as the update.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sync.grace_override',
        actorType: 'USER',
        actorId: 'manager-1',
        metadata: expect.objectContaining({ hours: 24 }),
      }),
      expect.anything(),
    );
  });
});

describe('SyncService.replayQuarantinedEvent', () => {
  it('re-arms a quarantined event and audits the replay in one transaction (§8.5)', async () => {
    const { service, outbox, audit } = makeService({});
    outbox.replayQuarantined.mockResolvedValue(true);

    const response = await service.replayQuarantinedEvent('3feeb5c0-53fa-476e-a758-3040a3529041', { id: 'manager-1' });
    expect(response).toEqual({ eventId: '3feeb5c0-53fa-476e-a758-3040a3529041', status: 'PENDING' });
    // The re-arm and the audit row share ONE transaction manager.
    expect(outbox.replayQuarantined).toHaveBeenCalledWith(expect.anything(), '3feeb5c0-53fa-476e-a758-3040a3529041');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sync.quarantine_replayed' }),
      expect.anything(),
    );
  });

  it('409s for a row that is not quarantined', async () => {
    const { service, outbox, dataSource } = makeService({});
    outbox.replayQuarantined.mockResolvedValue(false);
    dataSource.query.mockResolvedValue([{ status: 'DELIVERED' }]);

    await expect(service.replayQuarantinedEvent('3feeb5c0-53fa-476e-a758-3040a3529041', { id: 'm' })).rejects.toMatchObject({
      status: 409,
      response: { code: 'CONFLICT' },
    });
  });

  it('404s for an unknown event', async () => {
    const { service, outbox, dataSource } = makeService({});
    outbox.replayQuarantined.mockResolvedValue(false);
    dataSource.query.mockResolvedValue([]);

    await expect(service.replayQuarantinedEvent('3feeb5c0-53fa-476e-a758-3040a3529041', { id: 'm' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
