import { salesControllerGetSale } from '#/api/generated/clients/salesControllerGetSale'
import { salesControllerListSales } from '#/api/generated/clients/salesControllerListSales'
import { saleResponseSchema } from '#/api/generated/schemas/saleResponseSchema'
import { saleSummaryResponseSchema } from '#/api/generated/schemas/saleSummaryResponseSchema'
import type { SaleResponse } from '#/api/generated/types/SaleResponse'

export type SaleSummary = {
  id: string
  receiptNo: string
  totalMinor: string
  currencyCode: string
  status: string
  soldAt: string
  lineCount: number
}

export type SalesRange = { from?: string; to?: string }

/** One history page: rows parsed with the generated schema + the page cursor. */
export type SalesPage = { rows: SaleSummary[]; nextCursor?: string }

/**
 * `GET /sales` — requested with `throwOnError: false` so the native response
 * (with the envelope `meta.nextCursor`) is reachable; errors still reject
 * through the shared axios layer.
 */
export async function fetchSalesPage(
  range: SalesRange,
  cursor?: string,
): Promise<SalesPage> {
  const result = await salesControllerListSales({
    query: {
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      limit: 50,
      ...(cursor ? { cursor } : {}),
    },
    throwOnError: false,
  })
  // Errors reject through the shared axios layer (ApiError), so a resolved
  // result always carries data.
  const rows = result.data.map((row) => saleSummaryResponseSchema.parse(row))
  const meta = (result.response as { envelopeMeta?: { nextCursor?: string } })
    .envelopeMeta
  return {
    rows,
    nextCursor: meta?.nextCursor,
  }
}

/** `GET /sales/:id` — receipt detail with immutable snapshots (AT-19). */
export async function fetchSale(saleId: string): Promise<SaleResponse> {
  const data = await salesControllerGetSale({ path: { id: saleId } })
  return saleResponseSchema.parse(data)
}
