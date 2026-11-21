import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { CatalogItemEntity } from '../../database/entities/catalog-item.entity.js';
import { MenuSyncStateEntity } from '../../database/entities/menu-sync-state.entity.js';
import { SaleEntity } from '../../database/entities/sale.entity.js';
import { SaleIdempotencyKeyEntity } from '../../database/entities/sale-idempotency-key.entity.js';
import { SaleItemEntity } from '../../database/entities/sale-item.entity.js';
import { StockMovementEntity } from '../../database/entities/stock-movement.entity.js';

/** A merged, catalog-resolved sale line. */
export type ResolvedLine = {
  menuItemId: string;
  quantity: number;
  name: string;
  sku: string;
  unitPriceMinor: string;
  currencyCode: string;
  active: boolean;
};

/** Keyset pagination cursor over `(sold_at, id)` descending. */
export type SaleCursor = { soldAt: string; id: string };

/** Sale row plus its merged line count for the history listing. */
export type SaleWithLineCount = SaleEntity & { lineCount: number };

/**
 * Sale persistence (PRD §6.2, §8.6). Every write participates in the caller's
 * sale transaction — methods take `manager` as their first parameter and
 * never open their own transaction or fall back to the pool DataSource
 * (root AGENTS §3.4). Concurrency safety comes from row locks, atomic
 * conditional updates and unique constraints — never a JS mutex.
 */
@Injectable()
export class SalesRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * Serializes concurrent requests carrying the same idempotency key: the
   * transaction-scoped advisory lock is held until COMMIT/ROLLBACK, so the
   * loser of the race finds the winner's committed idempotency row and
   * replays it instead of double-charging (AT-07/AT-08).
   */
  async lockIdempotencyKey(manager: EntityManager, outletId: string, key: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${outletId}:${key}`,
    ]);
  }

  async findIdempotencyKey(
    manager: EntityManager,
    outletId: string,
    key: string,
  ): Promise<SaleIdempotencyKeyEntity | null> {
    return manager.getRepository(SaleIdempotencyKeyEntity).findOne({
      where: { outletId, key },
    });
  }

  async insertIdempotencyKey(
    manager: EntityManager,
    row: {
      outletId: string;
      key: string;
      requestSha256: string;
      saleId: string;
      responseJson: Record<string, unknown>;
      expiresAt: Date;
    },
  ): Promise<void> {
    const repo = manager.getRepository(SaleIdempotencyKeyEntity);
    // jsonb column typing is a deep-partial mismatch for TypeORM's insert;
    // the row shape is exact by construction.
    await repo.insert(repo.create(row) as never);
  }

  /** Grace-policy input (PRD §8.8): the menu-sync checkpoint. */
  async getSyncState(manager: EntityManager): Promise<MenuSyncStateEntity | null> {
    return manager.getRepository(MenuSyncStateEntity).findOne({ where: {} });
  }

  async loadCatalogItems(
    manager: EntityManager,
    menuItemIds: string[],
  ): Promise<CatalogItemEntity[]> {
    if (menuItemIds.length === 0) return [];
    return manager
      .getRepository(CatalogItemEntity)
      .createQueryBuilder('item')
      .where('item.menu_item_id IN (:...ids)', { ids: menuItemIds })
      .getMany();
  }

  /**
   * Atomic conditional stock decrement (PRD §8.6): succeeds exactly when
   * `quantity_on_hand >= quantity`. Returns the surviving on-hand figure, or
   * null when the row is missing/short — the caller then reads the current
   * availability for the INSUFFICIENT_STOCK details.
   */
  async decrementStock(
    manager: EntityManager,
    menuItemId: string,
    quantity: string,
  ): Promise<{ quantityOnHand: string } | null> {
    const result = await manager.query(
      `UPDATE inventory_balances
         SET quantity_on_hand = quantity_on_hand - $2,
             version = version + 1,
             updated_at = now()
       WHERE menu_item_id = $1 AND quantity_on_hand >= $2
       RETURNING quantity_on_hand`,
      [menuItemId, quantity],
    );
    // TypeORM's raw `query()` wraps UPDATE..RETURNING as `[rows, affected]`;
    // unwrap so "no matching row" is a true empty result, never the wrapper.
    const rows: Array<{ quantity_on_hand: string }> = Array.isArray(result?.[0])
      ? result[0]
      : (result ?? []);
    const row = rows[0];
    return row ? { quantityOnHand: row.quantity_on_hand } : null;
  }

  async currentStock(manager: EntityManager, menuItemId: string): Promise<string> {
    const rows = await manager.query<{ quantity_on_hand: string | null }[]>(
      'SELECT quantity_on_hand FROM inventory_balances WHERE menu_item_id = $1',
      [menuItemId],
    );
    return rows[0]?.quantity_on_hand ?? '0';
  }

  async insertSale(
    manager: EntityManager,
    sale: {
      id: string;
      outletId: string;
      receiptNumber: string;
      receiptNo: string;
      totalMinor: string;
      currencyCode: string;
      catalogRevision: string;
      soldAt: Date;
      createdBy: string;
    },
  ): Promise<void> {
    const repo = manager.getRepository(SaleEntity);
    await repo.insert(
      repo.create({ ...sale, status: 'COMPLETED' }),
    );
  }

  async insertSaleItems(
    manager: EntityManager,
    rows: ReadonlyArray<{
      id: string;
      saleId: string;
      menuItemId: string;
      nameSnapshot: string;
      skuSnapshot: string;
      quantity: number;
      unitPriceMinor: string;
      subtotalMinor: string;
      catalogRevision: string;
    }>,
  ): Promise<void> {
    const repo = manager.getRepository(SaleItemEntity);
    await repo.insert(rows.map((row) => repo.create(row)));
  }

  async insertSaleMovements(
    manager: EntityManager,
    rows: ReadonlyArray<{
      menuItemId: string;
      deltaQuantity: string;
      sourceSaleId: string;
      actorId: string;
      requestId: string | null;
      occurredAt: Date;
    }>,
  ): Promise<void> {
    const repo = manager.getRepository(StockMovementEntity);
    await repo.insert(
      rows.map((row) => repo.create({ ...row, reason: 'SALE' as const })),
    );
  }

  // -------------------------------------------------------------------------
  // Read path (no caller transaction)
  // -------------------------------------------------------------------------

  async findSaleById(saleId: string): Promise<SaleEntity | null> {
    return this.dataSource.getRepository(SaleEntity).findOne({ where: { id: saleId } });
  }

  async findSaleItems(saleId: string): Promise<SaleItemEntity[]> {
    return this.dataSource
      .getRepository(SaleItemEntity)
      .find({ where: { saleId }, order: { menuItemId: 'ASC' } });
  }

  async listSales(
    limit: number,
    range: { from?: Date; to?: Date },
    cursor?: SaleCursor,
  ): Promise<{ sales: SaleWithLineCount[]; nextCursor: string | undefined }> {
    const query = this.dataSource
      .getRepository(SaleEntity)
      .createQueryBuilder('sale')
      .orderBy('sale.sold_at', 'DESC')
      .addOrderBy('sale.id', 'DESC')
      .take(limit + 1);
    if (range.from) query.andWhere('sale.sold_at >= :from', { from: range.from });
    if (range.to) query.andWhere('sale.sold_at <= :to', { to: range.to });
    if (cursor) {
      query.andWhere('(sale.sold_at, sale.id) < (:soldAt, :id)', {
        soldAt: new Date(cursor.soldAt),
        id: cursor.id,
      });
    }
    const rows = await query.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const counts = await this.lineCountsOf(page.map((sale) => sale.id));
    const last = page.at(-1);
    return {
      sales: page.map((sale) => ({
        id: sale.id,
        outletId: sale.outletId,
        receiptNumber: sale.receiptNumber,
        receiptNo: sale.receiptNo,
        totalMinor: sale.totalMinor,
        currencyCode: sale.currencyCode,
        status: sale.status,
        catalogRevision: sale.catalogRevision,
        soldAt: sale.soldAt,
        createdBy: sale.createdBy,
        createdAt: sale.createdAt,
        lineCount: counts.get(sale.id) ?? 0,
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ soldAt: last.soldAt.toISOString(), id: last.id }),
              'utf8',
            ).toString('base64url')
          : undefined,
    };
  }

  private async lineCountsOf(saleIds: string[]): Promise<Map<string, number>> {
    if (saleIds.length === 0) return new Map();
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('item.sale_id', 'saleId')
      .addSelect('COUNT(*)', 'count')
      .from(SaleItemEntity, 'item')
      .where('item.sale_id IN (:...ids)', { ids: saleIds })
      .groupBy('item.sale_id')
      .getRawMany<{ saleId: string; count: string }>();
    return new Map(rows.map((row) => [row.saleId, Number(row.count)]));
  }
}

export function decodeSaleCursor(raw: string | undefined): SaleCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SaleCursor;
    if (typeof parsed.soldAt !== 'string' || typeof parsed.id !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
