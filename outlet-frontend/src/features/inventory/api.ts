import { inventoryControllerAdjust } from '#/api/generated/clients/inventoryControllerAdjust'
import { inventoryControllerListBalances } from '#/api/generated/clients/inventoryControllerListBalances'
import { inventoryBalanceResponseSchema } from '#/api/generated/schemas/inventoryBalanceResponseSchema'
import { adjustInventoryResponseSchema } from '#/api/generated/schemas/adjustInventoryResponseSchema'

export type InventoryBalance = {
  menuItemId: string
  name: string
  sku: string
  quantityOnHand: number
  version: number
  updatedAt: string
}

export type AdjustmentReason = 'RESTOCK' | 'WRITE_OFF' | 'RECOUNT'

/** `GET /inventory` parsed with the generated schema (AGENTS §4.2). */
export async function fetchBalances(): Promise<InventoryBalance[]> {
  const data = await inventoryControllerListBalances()
  return data.map((row) => inventoryBalanceResponseSchema.parse(row))
}

/**
 * `POST /inventory/adjustments`: one audited movement per call; the server
 * re-validates the resulting balance (nonnegative) and records the actor +
 * request ID (FR-04/FR-05).
 */
export async function adjustInventory(input: {
  menuItemId: string
  deltaQuantity: number
  reason: AdjustmentReason
}): Promise<{ menuItemId: string; quantityOnHand: number; version: number }> {
  const data = await inventoryControllerAdjust({
    body: input,
    throwOnError: true,
  })
  return adjustInventoryResponseSchema.parse(data)
}
