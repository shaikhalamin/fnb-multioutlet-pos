import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { DATA_SOURCE } from '../../database/database.module.js';
// Value import (not `import type`): the class is an injection token.
import { InventoryRepository } from './inventory.repository.js';
import type { AdjustInventoryRequest, AdjustInventoryResponse, InventoryBalanceResponse } from './dto/inventory.dto.js';

/**
 * Local inventory operations (PRD §7.3, FR-05): balance reads and audited
 * adjustments. An adjustment is one transaction: lock the balance row
 * `FOR UPDATE`, assert the resulting quantity stays nonnegative, apply the
 * signed delta with `version + 1`, and append the stock-movement audit row
 * carrying reason/actor/request ID (FR-04). Nothing here talks to HQ.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly inventory: InventoryRepository,
  ) {}

  async listBalances(): Promise<InventoryBalanceResponse[]> {
    const rows = await this.inventory.listBalances();
    return rows.map((row) => ({
      menuItemId: row.menuItemId,
      name: row.name,
      sku: row.sku,
      quantityOnHand: toSafeQuantity(row.quantityOnHand, row.menuItemId),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async adjust(
    request: AdjustInventoryRequest,
    actor: { userId: string; requestId: string | null },
  ): Promise<AdjustInventoryResponse> {
    if (!(await this.inventory.catalogItemExists(request.menuItemId))) {
      throw new ApiException('ITEM_NOT_ASSIGNED', 'Item is not in the local catalog.', 422, {
        menuItemId: request.menuItemId,
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const balance = await this.inventory.lockBalance(manager, request.menuItemId);

      // Items can exist in the catalog before ever being stocked; a first
      // adjustment inserts the balance row (negative first delta impossible).
      if (!balance) {
        if (request.deltaQuantity < 0) {
          throw new ApiException('INSUFFICIENT_STOCK', 'Adjustment would take stock below zero.', 422, {
            menuItemId: request.menuItemId,
            requestedQuantity: request.deltaQuantity,
            availableQuantity: 0,
          });
        }
        const inserted = await this.inventory.insertBalance(manager, {
          menuItemId: request.menuItemId,
          quantityOnHand: BigInt(request.deltaQuantity).toString(),
        });
        await this.inventory.appendMovement(manager, {
          menuItemId: request.menuItemId,
          deltaQuantity: BigInt(request.deltaQuantity).toString(),
          reason: request.reason,
          sourceSaleId: null,
          actorId: actor.userId,
          requestId: actor.requestId,
          occurredAt: new Date(),
        });
        return toAdjustResponse(inserted);
      }

      // BigInt arithmetic only — balances are bigint end to end.
      const current = BigInt(balance.quantityOnHand);
      const delta = BigInt(request.deltaQuantity);
      const resulting = current + delta;
      if (resulting < 0n) {
        throw new ApiException('INSUFFICIENT_STOCK', 'Adjustment would take stock below zero.', 422, {
          menuItemId: request.menuItemId,
          requestedQuantity: request.deltaQuantity,
          availableQuantity: Number(current),
        });
      }

      const updated = await this.inventory.updateBalance(
        manager,
        request.menuItemId,
        resulting.toString(),
        balance.version + 1,
      );
      await this.inventory.appendMovement(manager, {
        menuItemId: request.menuItemId,
        deltaQuantity: delta.toString(),
        reason: request.reason,
        sourceSaleId: null,
        actorId: actor.userId,
        requestId: actor.requestId,
        occurredAt: new Date(),
      });
      return toAdjustResponse(updated);
    });
  }
}

function toSafeQuantity(raw: string, menuItemId: string): number {
  const quantity = Number(raw);
  if (!Number.isSafeInteger(quantity)) {
    throw new ApiException('CONFLICT', 'Stock figure is out of representable range.', 409, {
      menuItemId,
    });
  }
  return quantity;
}

function toAdjustResponse(balance: {
  menuItemId: string;
  quantityOnHand: string;
  version: number;
  updatedAt: Date;
}): AdjustInventoryResponse {
  return {
    menuItemId: balance.menuItemId,
    quantityOnHand: toSafeQuantity(balance.quantityOnHand, balance.menuItemId),
    version: balance.version,
    updatedAt: balance.updatedAt.toISOString(),
  };
}
