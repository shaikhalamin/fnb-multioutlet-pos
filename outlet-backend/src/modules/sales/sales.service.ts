import { randomUUID, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { ReceiptCounterRepository } from '../receipts/receipt-counter.repository.js';
import { OutboxRepository } from '../outbox/outbox.repository.js';
import type { CreateSaleRequest } from './dto/sale.dto.js';
import type { SaleResponse, SaleSummaryResponse } from './dto/sale.dto.js';
import { decodeSaleCursor, SalesRepository } from './sales.repository.js';

/** A client line after merging duplicates by menuItemId. */
type MergedLine = { menuItemId: string; quantity: number };

/**
 * Merges duplicate request lines by `menuItemId` (summing quantities) and
 * sorts by ID — the canonical line order used for hashing, locking and
 * inserts (PRD §7.3 "normalize by ID before hashing and validating").
 */
export function mergeLines(items: ReadonlyArray<{ menuItemId: string; quantity: number }>): MergedLine[] {
  const byId = new Map<string, number>();
  for (const line of items) {
    byId.set(line.menuItemId, (byId.get(line.menuItemId) ?? 0) + line.quantity);
  }
  return [...byId.entries()]
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }))
    .sort((a, b) => (a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0));
}

/** SHA-256 over the canonical request (key + sorted merged lines). */
export function hashRequest(idempotencyKey: string, lines: MergedLine[]): string {
  const canonical = JSON.stringify({
    idempotencyKey,
    items: lines.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The atomic, idempotent multi-item sale (PRD §8.6, FR-06) — the most
 * protected code in this repo. One QueryRunner transaction, exact §8.6
 * order, `BigInt` money math, zero queue/HTTP calls inside the transaction.
 * Every failure rolls back every side effect.
 */
@Injectable()
export class SalesService {
  private readonly outletId: string;
  private readonly offlineGraceHours: number;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly sales: SalesRepository,
    private readonly receiptCounters: ReceiptCounterRepository,
    private readonly outbox: OutboxRepository,
    config: ConfigService<Env, true>,
  ) {
    this.outletId = config.get('OUTLET_ID', { infer: true });
    this.offlineGraceHours = config.get('OFFLINE_GRACE_HOURS', { infer: true });
  }

  async createSale(
    request: CreateSaleRequest,
    actor: { idempotencyKey: string; user: AuthenticatedUser; requestId: string | null },
  ): Promise<SaleResponse> {
    // (2) Merge duplicate lines by menuItemId BEFORE hashing/validating.
    const merged = mergeLines(request.items);
    // Defense in depth: per-line bounds passed the DTO, but merged duplicates
    // must still respect the per-line quantity ceiling (PRD §7.3).
    for (const line of merged) {
      if (line.quantity > 100_000) {
        throw new ApiException(
          'VALIDATION_FAILED',
          'Merged line quantity exceeds the maximum of 100000.',
          422,
          { menuItemId: line.menuItemId, mergedQuantity: line.quantity },
        );
      }
    }
    const requestSha256 = hashRequest(actor.idempotencyKey, merged);

    return this.dataSource.transaction(async (manager) => {
      // (3) Serialize same-key requests, then insert/lock the idempotency
      // claim: an existing row replays its stored response (AT-07) or is a
      // key-reuse 409 (AT-08).
      await this.sales.lockIdempotencyKey(manager, this.outletId, actor.idempotencyKey);
      const existing = await this.sales.findIdempotencyKey(manager, this.outletId, actor.idempotencyKey);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          throw new ApiException(
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used with a different request.',
            409,
            { idempotencyKey: actor.idempotencyKey },
          );
        }
        // Successful prior result: replay the stored response verbatim —
        // no second deduction, no second event.
        return existing.responseJson as unknown as SaleResponse;
      }

      // (4) Offline grace policy (PRD §8.8): a stale menu sync blocks new
      // sales until sync succeeds (emergency override is Phase 3).
      const syncState = await this.sales.getSyncState(manager);
      const lastSyncAt = syncState?.lastSyncAt;
      if (!lastSyncAt || Date.now() - lastSyncAt.getTime() > this.offlineGraceHours * 3_600_000) {
        throw new ApiException(
          'SYNC_TEMPORARILY_UNAVAILABLE',
          'Menu sync is stale; new sales are blocked until the catalog is refreshed.',
          503,
          {
            lastMenuSyncAt: lastSyncAt?.toISOString() ?? null,
            offlineGraceHours: this.offlineGraceHours,
          },
        );
      }
      const catalogRevision = syncState.lastAppliedRevision;

      // (5) Load active catalog rows; resolve persisted effective prices.
      const catalogItems = await this.sales.loadCatalogItems(
        manager,
        merged.map((line) => line.menuItemId),
      );
      const byId = new Map(catalogItems.map((item) => [item.menuItemId, item]));
      for (const line of merged) {
        const item = byId.get(line.menuItemId);
        if (!item) {
          throw new ApiException('ITEM_NOT_ASSIGNED', 'Item is not in the local catalog.', 422, {
            menuItemId: line.menuItemId,
          });
        }
        if (!item.active) {
          throw new ApiException('ITEM_INACTIVE', 'Item is inactive in the local catalog.', 422, {
            menuItemId: line.menuItemId,
          });
        }
      }

      // (6) Atomic conditional stock updates in sorted menuItemId order —
      // the deterministic lock order that keeps concurrent sales deadlock-free.
      for (const line of merged) {
        const decrement = await this.sales.decrementStock(
          manager,
          line.menuItemId,
          BigInt(line.quantity).toString(),
        );
        if (!decrement) {
          const available = await this.sales.currentStock(manager, line.menuItemId);
          throw new ApiException(
            'INSUFFICIENT_STOCK',
            'Insufficient stock for one or more items; the sale was rolled back.',
            409,
            {
              menuItemId: line.menuItemId,
              requestedQuantity: line.quantity,
              availableQuantity: Number(available),
            },
          );
        }
      }

      // (7) Append the audited stock movements (FR-04).
      const soldAt = new Date();
      const saleId = randomUUID();
      await this.sales.insertSaleMovements(
        manager,
        merged.map((line) => ({
          menuItemId: line.menuItemId,
          deltaQuantity: BigInt(-line.quantity).toString(),
          sourceSaleId: saleId,
          actorId: actor.user.id,
          requestId: actor.requestId,
          occurredAt: soldAt,
        })),
      );

      // (8) Lock the receipt counter and allocate the next number.
      const allocation = await this.receiptCounters.allocate(manager, this.outletId);

      // (9) Insert the sale + immutable snapshot lines; all math in BigInt.
      const currencyCode = byId.get(merged[0].menuItemId)?.currencyCode ?? 'USD';
      const lineRows = merged.map((line) => {
        const item = byId.get(line.menuItemId);
        if (!item) throw new Error(`catalog item vanished mid-transaction: ${line.menuItemId}`);
        const unitPrice = BigInt(item.effectivePriceMinor);
        return {
          id: randomUUID(),
          saleId,
          menuItemId: line.menuItemId,
          nameSnapshot: item.name,
          skuSnapshot: item.sku,
          quantity: line.quantity,
          unitPriceMinor: unitPrice.toString(),
          subtotalMinor: (unitPrice * BigInt(line.quantity)).toString(),
          catalogRevision,
        };
      });
      const totalMinor = lineRows.reduce((sum, row) => sum + BigInt(row.subtotalMinor), 0n);
      await this.sales.insertSale(manager, {
        id: saleId,
        outletId: this.outletId,
        receiptNumber: allocation.receiptNumber,
        receiptNo: allocation.receiptNo,
        totalMinor: totalMinor.toString(),
        currencyCode,
        catalogRevision,
        soldAt,
        createdBy: actor.user.id,
      });
      await this.sales.insertSaleItems(manager, lineRows);

      // (10) Allocate the outbox sequence and insert the sale.completed
      // event (AT-03: exactly one outbox row per sale).
      await this.outbox.insertSaleCompletedEvent(manager, {
        outletId: this.outletId,
        occurredAt: soldAt,
        saleId,
        receiptNo: allocation.receiptNo,
        catalogRevision,
        currencyCode,
        soldAt,
        totalMinor: totalMinor.toString(),
        items: lineRows.map((row) => ({
          saleItemId: row.id,
          menuItemId: row.menuItemId,
          nameSnapshot: row.nameSnapshot,
          skuSnapshot: row.skuSnapshot,
          quantity: row.quantity,
          unitPriceMinor: row.unitPriceMinor,
          subtotalMinor: row.subtotalMinor,
        })),
      });

      // (11) Persist the idempotency response, then (12) COMMIT — the
      // DataSource transaction commits when this callback resolves.
      const response: SaleResponse = {
        id: saleId,
        receiptNo: allocation.receiptNo,
        outletId: this.outletId,
        status: 'COMPLETED',
        currencyCode,
        items: lineRows.map((row) => ({
          saleItemId: row.id,
          menuItemId: row.menuItemId,
          name: row.nameSnapshot,
          sku: row.skuSnapshot,
          quantity: row.quantity,
          unitPriceMinor: row.unitPriceMinor,
          subtotalMinor: row.subtotalMinor,
        })),
        totalMinor: totalMinor.toString(),
        catalogRevision,
        soldAt: soldAt.toISOString(),
        syncStatus: 'PENDING',
      };
      await this.sales.insertIdempotencyKey(manager, {
        outletId: this.outletId,
        key: actor.idempotencyKey,
        requestSha256,
        saleId,
        responseJson: response as unknown as Record<string, unknown>,
        // Retain well beyond any client retry horizon (PRD §6.2).
        expiresAt: new Date(soldAt.getTime() + 30 * 24 * 3_600_000),
      });
      return response;
    });
  }

  async getSale(saleId: string): Promise<SaleResponse> {
    const sale = await this.sales.findSaleById(saleId);
    if (!sale) {
      throw new ApiException('NOT_FOUND', 'Sale not found.', 404);
    }
    const items = await this.sales.findSaleItems(sale.id);
    const syncStatus = (await this.outbox.findStatusBySaleId(sale.id)) ?? 'PENDING';
    return {
      id: sale.id,
      receiptNo: sale.receiptNo,
      outletId: sale.outletId,
      status: sale.status,
      currencyCode: sale.currencyCode,
      items: items.map((item) => ({
        saleItemId: item.id,
        menuItemId: item.menuItemId,
        name: item.nameSnapshot,
        sku: item.skuSnapshot,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        subtotalMinor: item.subtotalMinor,
      })),
      totalMinor: sale.totalMinor,
      catalogRevision: sale.catalogRevision,
      soldAt: sale.soldAt.toISOString(),
      syncStatus,
    };
  }

  async listSales(
    limit: number,
    range: { from?: string; to?: string },
    cursor?: string,
  ): Promise<{ sales: SaleSummaryResponse[]; nextCursor: string | undefined }> {
    const page = await this.sales.listSales(
      limit,
      { from: range.from ? new Date(range.from) : undefined, to: range.to ? new Date(range.to) : undefined },
      decodeSaleCursor(cursor),
    );
    return {
      sales: page.sales.map((sale) => ({
        id: sale.id,
        receiptNo: sale.receiptNo,
        totalMinor: sale.totalMinor,
        currencyCode: sale.currencyCode,
        status: sale.status,
        soldAt: sale.soldAt.toISOString(),
        lineCount: sale.lineCount,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
