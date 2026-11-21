import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { HqSaleEntity } from '../../database/entities/hq-sale.entity.js';
import { HqSaleItemEntity } from '../../database/entities/hq-sale-item.entity.js';
import { SyncInboxEventEntity } from '../../database/entities/sync-inbox-event.entity.js';
import type { SyncEventV1 } from './dto/event-batch.dto.js';

export type InboxIdentity = {
  eventId: string;
  sequenceNo: string;
  payloadSha256: string;
};

/**
 * HQ inbox persistence (PRD §6.1, §8.5–§8.6): immutable dedupe identities and
 * the accepted-sale projections. Every write participates in the caller's
 * per-event transaction — inbox row, `hq_sales` and `hq_sale_items` commit
 * together or not at all.
 */
@Injectable()
export class SyncInboxRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  findInboxEvent(
    managerOrPool: EntityManager | DataSource,
    outletId: string,
    eventId: string,
  ): Promise<InboxIdentity | null> {
    return managerOrPool
      .getRepository(SyncInboxEventEntity)
      .findOne({ where: { outletId, eventId } })
      .then((row) =>
        row ? { eventId: row.eventId, sequenceNo: row.sequenceNo, payloadSha256: row.payloadSha256 } : null,
      );
  }

  findInboxEventBySequence(
    manager: EntityManager,
    outletId: string,
    sequenceNo: string,
  ): Promise<InboxIdentity | null> {
    return manager
      .getRepository(SyncInboxEventEntity)
      .findOne({ where: { outletId, sequenceNo } })
      .then((row) =>
        row ? { eventId: row.eventId, sequenceNo: row.sequenceNo, payloadSha256: row.payloadSha256 } : null,
      );
  }

  /**
   * One HQ transaction's writes (§8.6): inbox dedupe row, immutable sale
   * projection with snapshot lines. Projection values are copied verbatim
   * from the event — never recomputed from today's catalog (§8.1, AT-19).
   */
  async insertAcceptedEvent(manager: EntityManager, event: SyncEventV1, payloadSha256: string): Promise<void> {
    const inboxRepo = manager.getRepository(SyncInboxEventEntity);
    await inboxRepo.insert(
      inboxRepo.create({
        outletId: event.outletId,
        eventId: event.eventId,
        sequenceNo: event.sequenceNo,
        eventType: event.eventType,
        payloadSha256,
        schemaVersion: event.schemaVersion,
        status: 'ACCEPTED',
      }),
    );

    const salesRepo = manager.getRepository(HqSaleEntity);
    const sale = salesRepo.create({
      outletId: event.outletId,
      sourceSaleId: event.data.saleId,
      receiptNo: event.data.receiptNo,
      soldAt: new Date(event.data.soldAt),
      totalMinor: event.data.totalMinor,
      currencyCode: event.data.currencyCode,
      status: 'COMPLETED',
    });
    await salesRepo.insert(sale);

    const itemsRepo = manager.getRepository(HqSaleItemEntity);
    await itemsRepo.insert(
      event.data.items.map((item) =>
        itemsRepo.create({
          hqSaleId: sale.id,
          sourceSaleItemId: item.saleItemId,
          menuItemId: item.menuItemId,
          nameSnapshot: item.nameSnapshot,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          subtotalMinor: item.subtotalMinor,
        }),
      ),
    );
  }

  /** Sequences accepted for the outlet, ascending (missing-range input). */
  async listSequences(outletId: string, maxRows: number): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ seq: string }>>(
      'SELECT sequence_no::text AS seq FROM sync_inbox_events WHERE outlet_id = $1 ORDER BY sequence_no LIMIT $2',
      [outletId, maxRows],
    );
    return rows.map((row) => row.seq);
  }
}
