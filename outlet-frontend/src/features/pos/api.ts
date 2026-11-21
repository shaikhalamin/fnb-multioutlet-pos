import { menuCacheControllerGetMenu } from '#/api/generated/clients/menuCacheControllerGetMenu'
import { salesControllerCreateSale } from '#/api/generated/clients/salesControllerCreateSale'
import { outletMenuItemResponseSchema } from '#/api/generated/schemas/outletMenuItemResponseSchema'
import { saleResponseSchema } from '#/api/generated/schemas/saleResponseSchema'
import type { SaleResponse } from '#/api/generated/types/SaleResponse'

export type MenuItem = {
  menuItemId: string
  sku: string
  name: string
  description: string
  category: string
  unitPriceMinor: string
  currencyCode: string
  availableQuantity: number
}

export type SaleLine = { menuItemId: string; quantity: number }

/**
 * `GET /menu` parsed with the generated schema (AGENTS §4.2 — money-bearing
 * payloads are parsed in the queryFn before render).
 */
export async function fetchMenu(): Promise<MenuItem[]> {
  const data = await menuCacheControllerGetMenu()
  return data.map((item) => outletMenuItemResponseSchema.parse(item))
}

/**
 * `POST /sales` — the payload carries ONLY `items: [{menuItemId, quantity}]`
 * (PRD §7.3); the caller supplies the idempotency key minted once per sale
 * attempt and reused across retries (AGENTS §4.4). Totals and receipt come
 * exclusively from the authoritative response.
 */
export async function submitSale(
  idempotencyKey: string,
  items: SaleLine[],
): Promise<SaleResponse> {
  const data = await salesControllerCreateSale({
    body: { items },
    headers: { 'Idempotency-Key': idempotencyKey },
    throwOnError: true,
  })
  return saleResponseSchema.parse(data)
}
