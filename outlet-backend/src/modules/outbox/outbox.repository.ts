import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutboxCounterEntity } from '../../database/entities/outbox-counter.entity.js';
import { OutboxEventEntity, type OutboxStatus } from '../../database/entities/outbox-event.entity.js';
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
