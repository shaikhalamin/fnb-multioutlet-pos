import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ReceiptCounterEntity } from '../../database/entities/receipt-counter.entity.js';

/** Result of allocating the next receipt number inside the sale transaction. */
export type ReceiptAllocation = {
  /** Numeric counter value (`bigint` as decimal string). */
  receiptNumber: string;
  /** Display receipt, e.g. `A-000001` (PRD §6.2, §8.4 pattern). */
  receiptNo: string;
};

/**
 * Formats `{prefix}-{zero-padded-6}` — matches the sync-event v1 receipt
 * pattern `^[A-Za-z0-9_-]+-[0-9]{1,19}$` (PRD §8.4).
 */
export function formatReceiptNo(prefix: string, number: string | number): string {
  const n = typeof number === 'string' ? Number(number) : number;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`receipt number out of range: ${number}`);
  }
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

/**
 * Per-outlet receipt counter (PRD §6.2): the sale transaction locks the
 * singleton row `FOR UPDATE`, reads `next_number`, increments it, and derives
 * the display receipt. The row lock is the serialization point — two
 * concurrent sales can never observe the same number.
 */
@Injectable()
export class ReceiptCounterRepository {
  /**
   * Locks and advances the counter inside the caller's transaction.
   * `manager` is mandatory: the allocation is part of the sale unit of work.
   */
  async allocate(manager: EntityManager, outletId: string): Promise<ReceiptAllocation> {
    const repo = manager.getRepository(ReceiptCounterEntity);
    const counter = await repo
      .createQueryBuilder('counter')
      .setLock('pessimistic_write')
      .where('counter.outlet_id = :outletId', { outletId })
      .getOne();
    if (!counter) {
      throw new Error(`receipt counter missing for outlet ${outletId}`);
    }

    const current = BigInt(counter.nextNumber);
    if (current <= 0n) {
      throw new Error(`receipt counter corrupted for outlet ${outletId}: ${counter.nextNumber}`);
    }
    await repo.update({ outletId }, { nextNumber: (current + 1n).toString() });
    return {
      receiptNumber: current.toString(),
      receiptNo: formatReceiptNo(counter.prefix, current.toString()),
    };
  }
}
