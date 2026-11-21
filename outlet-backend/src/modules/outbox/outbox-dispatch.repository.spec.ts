import { describe, expect, it, vi } from 'vitest';
import { OutboxRepository, computeBackoffDelayMs } from './outbox.repository.js';

/** DataSource stub capturing repository calls (state-machine paths only). */
function makeDataSource() {
  const updates: Array<{ criteria: unknown; patch: Record<string, unknown> }> = {};
  const inserts: Array<Record<string, unknown>> = [];
  const ds = {
    getRepository: (entity: unknown) => {
      const name = (entity as { name?: string }).name;
      if (name === 'SyncAttemptLogEntity') {
        return {
          create: vi.fn((row: Record<string, unknown>) => row),
          insert: vi.fn(async (row: Record<string, unknown>) => {
            inserts.push(row);
          }),
        };
      }
      // OutboxEventEntity
      return {
        update: vi.fn(async (criteria: unknown, patch: Record<string, unknown>) => {
          updates[String(criteria?.id?.value ?? JSON.stringify(criteria))] = { criteria, patch };
        }),
        find: vi.fn(async () => []),
        createQueryBuilder: vi.fn(() => {
          const qb = {
            update: vi.fn(() => qb),
            set: vi.fn(() => qb),
            where: vi.fn(() => qb),
            execute: vi.fn(async () => ({ affected: 2 })),
          };
          return qb;
        }),
      };
    },
  } as never;
  return { ds, updates, inserts };
}

describe('computeBackoffDelayMs (PRD §8.7)', () => {
  it('grows exponentially and caps at the ceiling even with jitter', () => {
    const random = () => 0.5; // no jitter
    expect(computeBackoffDelayMs(1, null, random)).toBe(5_000);
    expect(computeBackoffDelayMs(2, null, random)).toBe(10_000);
    expect(computeBackoffDelayMs(3, null, random)).toBe(20_000);
    expect(computeBackoffDelayMs(10, null, random)).toBe(600_000);
    // Max jitter never exceeds the cap.
    const maxJitter = computeBackoffDelayMs(50, null, () => 1);
    expect(maxJitter).toBe(600_000);
  });

  it('stays within ±20% of the base delay', () => {
    const low = computeBackoffDelayMs(1, null, () => 0);
    const high = computeBackoffDelayMs(1, null, () => 1);
    expect(low).toBe(4_000);
    expect(high).toBe(6_000);
  });

  it('honors Retry-After exactly: never shortened by jitter, never capped below it', () => {
    expect(computeBackoffDelayMs(1, 30, () => 0.5)).toBe(30_000);
    // Downward jitter must not shave a server-provided Retry-After.
    expect(computeBackoffDelayMs(1, 30, () => 0)).toBe(30_000);
    // Beyond the exponential ceiling: the server floor wins over the cap.
    expect(computeBackoffDelayMs(1, 900, () => 1)).toBe(900_000);
    // Smaller than the exponential value → the computed backoff wins.
    expect(computeBackoffDelayMs(3, 1, () => 0.5)).toBe(20_000);
  });
});

describe('OutboxRepository dispatcher transitions', () => {
  it('markDelivered clears the lease, stamps publishedAt and nulls the error', async () => {
    const { ds, updates } = makeDataSource();
    const repo = new OutboxRepository(ds);
    const at = new Date('2026-11-20T04:02:10Z');
    await repo.markDelivered(['e1', 'e2'], at);
    const entry = Object.values(updates)[0];
    expect(entry.patch).toMatchObject({
      status: 'DELIVERED',
      publishedAt: at,
      nextAttemptAt: null,
      leaseUntil: null,
      lastError: null,
    });
  });

  it('markRetry schedules next_attempt_at after the backoff delay', async () => {
    const { ds, updates } = makeDataSource();
    const repo = new OutboxRepository(ds);
    const now = new Date('2026-11-20T04:00:00Z');
    await repo.markRetry(['e1'], 'HTTP 503', 5_000, now);
    const entry = Object.values(updates)[0];
    expect(entry.patch.status).toBe('RETRY');
    expect(entry.patch.nextAttemptAt).toEqual(new Date('2026-11-20T04:00:05Z'));
    expect(entry.patch.lastError).toBe('HTTP 503');
  });

  it('markQuarantined is terminal: no next attempt, error retained', async () => {
    const { ds, updates } = makeDataSource();
    const repo = new OutboxRepository(ds);
    await repo.markQuarantined('e1', 'EVENT_ID_CONFLICT');
    const entry = Object.values(updates)[0];
    expect(entry.patch).toMatchObject({
      status: 'QUARANTINED',
      nextAttemptAt: null,
      leaseUntil: null,
      lastError: 'EVENT_ID_CONFLICT',
    });
  });

  it('expireLeases reverts stalled leases to eligible', async () => {
    const { ds } = makeDataSource();
    const repo = new OutboxRepository(ds);
    const expired = await repo.expireLeases(new Date());
    expect(expired).toBe(2);
  });

  it('appendAttemptLog records status/duration/error without payload data', async () => {
    const { ds, inserts } = makeDataSource();
    const repo = new OutboxRepository(ds);
    await repo.appendAttemptLog({ outboxEventId: 'e1', statusCode: 200, durationMs: 42, errorCode: null });
    expect(inserts[0]).toMatchObject({ outboxEventId: 'e1', statusCode: 200, durationMs: 42, errorCode: null });
  });
});
