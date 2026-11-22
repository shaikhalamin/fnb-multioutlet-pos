import { useQuery } from '@tanstack/react-query'
import { reportingControllerRevenueByOutlet } from '#/api/generated/clients/reportingControllerRevenueByOutlet'
import { reportingControllerTopItems } from '#/api/generated/clients/reportingControllerTopItems'
import { reportingControllerRevenueByOutletStatus200Schema } from '#/api/generated/schemas/reportingControllerRevenueByOutletSchema'
import { reportingControllerTopItemsStatus200Schema } from '#/api/generated/schemas/reportingControllerTopItemsSchema'
import { reportKeys } from './keys'

/** Calendar-day boundaries become UTC instants: `from` at 00:00 inclusive,
 *  `to` at 00:00 exclusive (PRD §10 UTC-only windows in V1). */
function dayWindow(from: string, to: string) {
  return { from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` }
}

/**
 * Revenue per outlet for a UTC day window. Money-bearing, so the payload is
 * parsed with the generated Zod schema before it reaches render (AGENTS
 * §4.2). Both report tabs read it: the Top-items tab only takes the selected
 * outlet's watermark and the provisional flag from it.
 */
export function useRevenueReport(from: string, to: string) {
  return useQuery({
    queryKey: reportKeys.revenue({ from, to }),
    queryFn: async () =>
      reportingControllerRevenueByOutletStatus200Schema.parse(
        await reportingControllerRevenueByOutlet({
          query: dayWindow(from, to),
        }),
      ),
  })
}

/**
 * Top-selling items of one outlet (max 5 in V1). Pass `outletId: null` while
 * no outlet is selected: the query stays idle until there is one.
 */
export function useOutletTopItems(
  outletId: string | null,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: reportKeys.topItems({ outletId: outletId ?? 'none', from, to }),
    enabled: outletId !== null,
    queryFn: async () => {
      // Unreachable while `enabled` is false — this narrows the id for the call.
      if (outletId === null) throw new Error('No outlet selected')
      return reportingControllerTopItemsStatus200Schema.parse(
        await reportingControllerTopItems({
          path: { id: outletId },
          query: { ...dayWindow(from, to), limit: 5 },
        }),
      )
    },
  })
}
