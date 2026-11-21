import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutboxCounterEntity } from '../../database/entities/outbox-counter.entity.js';
import { OutboxEventEntity, type OutboxStatus } from '../../database/entities/outbox-event.entity.js';
import { SyncAttemptLogEntity } from '../../database/entities/sync-attempt-log.entity.js';
import { sha256OfCanonicalJson } from './canonical-json.js';

/** A committed sale ready to become one immutable `sale.completed` event. */
export type SaleCompletedDraft = {
  outletId: string;
  occurredAt: Date;
  saleId: string;
  receiptNo: string;
  catalogRevision: string;
  currencyCode: string;
  soldAt: Date;
  totalMinor: string;
  items: ReadonlyArray<{
    saleItemId: string;
    menuItemId: string;
    nameSnapshot: string;
    skuSnapshot: string;
    quantity: number;
    unitPriceMinor: string;
    subtotalMinor: string;
  }>;
};

/** The full sync-event payload exactly as `contracts/sync-event-v1.schema.json` defines it. */
export type SaleCompletedPayload = {
  eventId: string;
  eventType: 'sale.completed';
  schemaVersion: 1;
  outletId: string;
  sequenceNo: string;
  occurredAt: string;
  data: {
    saleId: string;
    receiptNo: string;
    catalogRevision: string;
    currencyCode: string;
    status: 'COMPLETED';
    soldAt: string;
    totalMinor: string;
    items: Array<{
      saleItemId: string;
      menuItemId: string;
      nameSnapshot: string;
      skuSnapshot: string;
      quantity: number;
      unitPriceMinor: string;
      subtotalMinor: string;
    }>;
  };
};

/**
 * Transactional outbox (PRD §6.2, §8.4–§8.6): every committed sale writes
 * exactly one immutable `sale.completed` row in the same transaction. The
 * Phase-2 sale path inserts `PENDING` rows only — delivery (leasing, retries,
 * quarantine) is the Phase-3 dispatcher; here we expose the read side the
 * sync-status endpoint needs.
 */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * Locks `outbox_counters` `FOR UPDATE` and increments it inside the
   * caller's transaction, yielding the next contiguous per-outlet sequence.
   */
  async allocateSequence(manager: EntityManager, outletId: string): Promise<string> {
    const repo = manager.getRepository(OutboxCounterEntity);
    const counter = await repo
      .createQueryBuilder('counter')
      .setLock('pessimistic_write')
      .where('counter.outlet_id = :outletId', { outletId })
      .getOne();
    if (!counter) {
      throw new Error(`outbox counter missing for outlet ${outletId}`);
    }
    const current = BigInt(counter.nextSequence);
    await repo.update({ outletId }, { nextSequence: (current + 1n).toString() });
    return current.toString();
  }

  /**
   * Builds the v1 payload (eventId = the outbox row UUID) and inserts the
   * `PENDING` row with `payload_sha256` over the canonical JSON. Integrity
   * invariants (quantity × unitPrice = subtotal; Σ subtotal = total) are
   * asserted here so a malformed sale can never reach the outbox.
   */
  async insertSaleCompletedEvent(
    manager: EntityManager,
    draft: SaleCompletedDraft,
  ): Promise<OutboxEventEntity> {
    assertSaleInvariants(draft);

    const sequenceNo = await this.allocateSequence(manager, draft.outletId);
    const payload: SaleCompletedPayload = {
      eventId: randomUUID(),
      eventType: 'sale.completed',
      schemaVersion: 1,
      outletId: draft.outletId,
      sequenceNo,
      occurredAt: draft.occurredAt.toISOString(),
      data: {
        saleId: draft.saleId,
        receiptNo: draft.receiptNo,
        catalogRevision: draft.catalogRevision,
        currencyCode: draft.currencyCode,
        status: 'COMPLETED',
        soldAt: draft.soldAt.toISOString(),
        totalMinor: draft.totalMinor,
        items: draft.items.map((item) => ({ ...item })),
      },
    };

    const repo = manager.getRepository(OutboxEventEntity);
    const row = repo.create({
      id: payload.eventId,
      outletId: draft.outletId,
      sequenceNo,
      eventType: payload.eventType,
      schemaVersion: payload.schemaVersion,
      payload: payload as unknown as Record<string, unknown>,
      payloadSha256: sha256OfCanonicalJson(payload),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      leaseUntil: null,
      publishedAt: null,
      lastError: null,
    });
    // jsonb column typing is a deep-partial mismatch for TypeORM's insert;
    // the row shape is exact by construction.
    await repo.insert(row as never);
    return row;
  }

  /** Sync status of a sale via the jsonb expression index (PRD §8.7). */
  async findStatusBySaleId(saleId: string): Promise<OutboxStatus | null> {
    const rows = await this.dataSource.query<{ status: OutboxStatus }[]>(
      'SELECT status FROM outbox_events WHERE payload->\'data\'->>\'saleId\' = $1 LIMIT 1',
      [saleId],
    );
    return rows[0]?.status ?? null;
  }

  /** Per-status counts for the local sync-status endpoint. */
  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const rows = await this.dataSource.query<{ status: OutboxStatus; count: string }[]>(
      'SELECT status, COUNT(*)::text AS count FROM outbox_events GROUP BY status',
    );
    const counts: Record<OutboxStatus, number> = { PENDING: 0, RETRY: 0, DELIVERED: 0, QUARANTINED: 0 };
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  /** Oldest undelivered event timestamp (grace/alerting input), if any. */
  async oldestPendingAt(): Promise<Date | null> {
    const rows = await this.dataSource.query<{ oldest: string | null }[]>(
      "SELECT MIN(created_at) AS oldest FROM outbox_events WHERE status IN ('PENDING', 'RETRY')",
    );
    return rows[0]?.oldest ? new Date(rows[0].oldest) : null;
  }

  async lastPublishedAt(): Promise<Date | null> {
    const rows = await this.dataSource.query<{ latest: string | null }[]>(
      'SELECT MAX(published_at) AS latest FROM outbox_events WHERE status = \'DELIVERED\'',
    );
    return rows[0]?.latest ? new Date(rows[0].latest) : null;
  }

  // ---- Phase 3 dispatcher state machine (PRD §8.6 A–G) -----------------------

  /**
   * Leases due rows for delivery with `FOR UPDATE SKIP LOCKED` (§8.6 A):
   * status PENDING/RETRY, backoff elapsed, and no live lease. Leasing bumps
   * `attempts` (an attempt is starting) and stamps `lease_until`; two
   * concurrent sweepers can never lease the same row. One statement keeps the
   * lock and the lease write a single atomic step (TypeORM's `setLock` has no
   * SKIP LOCKED variant).
   */
  async leaseDueBatch(batchSize: number, leaseMs: number, now = new Date()): Promise<OutboxEventEntity[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `WITH due AS (
         SELECT id FROM outbox_events
         WHERE status IN ('PENDING', 'RETRY')
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           AND (lease_until IS NULL OR lease_until <= $1)
         ORDER BY sequence_no ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_events o
       SET lease_until = $3, attempts = o.attempts + 1
       FROM due
       WHERE o.id = due.id
       RETURNING o.*`,
      [now.toISOString(), batchSize, leaseUntil.toISOString()],
    );
    return rows.map(
      (row) =>
        ({
          id: String(row.id),
          outletId: String(row.outlet_id),
          sequenceNo: String(row.sequence_no),
          eventType: String(row.event_type),
          schemaVersion: Number(row.schema_version),
          payload: row.payload as Record<string, unknown>,
          payloadSha256: String(row.payload_sha256),
          status: row.status as OutboxStatus,
          attempts: Number(row.attempts),
          nextAttemptAt: row.next_attempt_at ? new Date(String(row.next_attempt_at)) : null,
          leaseUntil,
          publishedAt: row.published_at ? new Date(String(row.published_at)) : null,
          lastError: row.last_error === null ? null : String(row.last_error),
          createdAt: new Date(String(row.created_at)),
        }) satisfies OutboxEventEntity,
    );
  }

  /** Loads durable rows by ID — BullMQ jobs carry event IDs only (§13). */
  findByIds(ids: string[]): Promise<OutboxEventEntity[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.dataSource.getRepository(OutboxEventEntity).find({
      where: { id: In(ids) },
      order: { sequenceNo: 'ASC' },
    });
  }

  /**
   * Terminal success — only after an HQ `ACCEPTED` or hash-identical
   * `DUPLICATE` ack (§8.6 D: never mark delivered before HQ ack).
   */
  async markDelivered(ids: string[], at = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.dataSource
      .getRepository(OutboxEventEntity)
      .update({ id: In(ids) }, { status: 'DELIVERED', publishedAt: at, nextAttemptAt: null, leaseUntil: null, lastError: null });
  }

  /** Retry with capped exponential backoff + jitter (§8.6 E); honors Retry-After. */
  async markRetry(ids: string[], lastError: string, delayMs: number, now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.dataSource
      .getRepository(OutboxEventEntity)
      .update(
        { id: In(ids) },
        { status: 'RETRY', nextAttemptAt: new Date(now.getTime() + delayMs), leaseUntil: null, lastError },
      );
  }

  /** Terminal parking for permanent conflicts — never deleted (§8.6 F). */
  async markQuarantined(id: string, lastError: string): Promise<void> {
    await this.dataSource
      .getRepository(OutboxEventEntity)
      .update({ id }, { status: 'QUARANTINED', nextAttemptAt: null, leaseUntil: null, lastError });
  }

  /**
   * Returns stalled work to eligibility (§8.6 G): leases that expired
   * without an outcome revert to pickup by the periodic scanner.
   */
  async expireLeases(now = new Date()): Promise<number> {
    const result = await this.dataSource
      .getRepository(OutboxEventEntity)
      .createQueryBuilder()
      .update(OutboxEventEntity)
      .set({ leaseUntil: null })
      .where("lease_until IS NOT NULL AND lease_until <= :now AND status IN ('PENDING', 'RETRY')", { now })
      .execute();
    return result.affected ?? 0;
  }

  /** One append-only attempt row per send — status/duration/error, never secrets. */
  async appendAttemptLog(input: {
    outboxEventId: string;
    statusCode: number | null;
    durationMs: number;
    errorCode: string | null;
  }): Promise<void> {
    const repo = this.dataSource.getRepository(SyncAttemptLogEntity);
    const row = repo.create({
      outboxEventId: input.outboxEventId,
      statusCode: input.statusCode,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
    });
    // jsonb column typing is a deep-partial mismatch for TypeORM's insert;
    // the row shape is exact by construction.
    await repo.insert(row as never);
  }
}

// ---- Backoff (PRD §8.7) -----------------------------------------------------

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 10 * 60_000;
const RETRY_JITTER_RATIO = 0.2;

/**
 * Capped exponential backoff with ±20% jitter, honoring a server
 * `Retry-After` (seconds) when present (§8.7). Pure and deterministic under
 * a seeded random for tests.
 */
export function computeBackoffDelayMs(attempts: number, retryAfterSeconds?: number | null, random = Math.random): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_MS);
  const base = retryAfterSeconds && retryAfterSeconds > 0 ? Math.max(exponential, retryAfterSeconds * 1000) : exponential;
  const jitter = 1 + (random() * 2 - 1) * RETRY_JITTER_RATIO;
  return Math.min(Math.round(base * jitter), RETRY_MAX_DELAY_MS);
}

/** PRD §8.4 integrity invariants, enforced before any outbox write. */
function assertSaleInvariants(draft: SaleCompletedDraft): void {
  let total = 0n;
  for (const item of draft.items) {
    const unit = BigInt(item.unitPriceMinor);
    const subtotal = BigInt(item.subtotalMinor);
    if (BigInt(item.quantity) * unit !== subtotal) {
      throw new Error(
        `sale invariant violated: quantity × unitPrice ≠ subtotal for ${item.menuItemId}`,
      );
    }
    total += subtotal;
  }
  if (total !== BigInt(draft.totalMinor)) {
    throw new Error('sale invariant violated: Σ subtotal ≠ total');
  }
}
