import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { reportingControllerRevenueByOutlet } from '#/api/generated/clients/reportingControllerRevenueByOutlet'
import { reportingControllerTopItems } from '#/api/generated/clients/reportingControllerTopItems'
import { reportingControllerRevenueByOutletStatus200Schema } from '#/api/generated/schemas/reportingControllerRevenueByOutletSchema'
import { reportingControllerTopItemsStatus200Schema } from '#/api/generated/schemas/reportingControllerTopItemsSchema'
import { outletsControllerListOutletsQueryOptions } from '#/api/generated/queries/useOutletsControllerListOutlets'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatInstantUtc, formatMinor } from '#/lib/utils'

import { reportKeys } from '#/features/reports/keys'

/** Calendar-day shape carried in the URL (`from` inclusive, `to` exclusive, §10). */
const dayPattern = /^\d{4}-\d{2}-\d{2}$/

function monthWindow(now = new Date()): { from: string; to: string } {
  const pad = (value: number) => String(value).padStart(2, '0')
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  return {
    from: `${year}-${pad(month)}-01`,
    to: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
  }
}
const defaults = monthWindow()

const searchSchema = z.object({
  from: z.string().regex(dayPattern).catch(defaults.from),
  to: z.string().regex(dayPattern).catch(defaults.to),
  outletId: z.string().uuid().optional().catch(undefined),
})

/** Search payload for plain `<Link to="/reports">` navigations (current month). */
export function defaultReportSearch(): { from: string; to: string } {
  return monthWindow()
}

export const Route = createFileRoute('/_auth/reports')({
  validateSearch: searchSchema.parse,
  component: ReportsPage,
})

function ReportsPage() {
  const session = useSession()
  const navigate = useNavigate()
  const { from, to, outletId: outletParam } = Route.useSearch()

  const [draft, setDraft] = useState({ from, to })
  const [error, setError] = useState<string | null>(null)

  // Day boundaries become UTC instants: `from` at 00:00 inclusive, `to` at
  // 00:00 exclusive (PRD §10 UTC-only windows in V1).
  const fromInstant = `${from}T00:00:00Z`
  const toInstant = `${to}T00:00:00Z`

  const outlets = useQuery(outletsControllerListOutletsQueryOptions())
  const outletId =
    outletParam ?? outlets.data?.find((o) => o.status === 'ACTIVE')?.id ?? null

  const revenue = useQuery({
    queryKey: reportKeys.revenue({ from, to }),
    queryFn: async () =>
      reportingControllerRevenueByOutletStatus200Schema.parse(
        await reportingControllerRevenueByOutlet({
          query: { from: fromInstant, to: toInstant },
        }),
      ),
  })

  const topItems = useQuery({
    queryKey: reportKeys.topItems({ outletId: outletId ?? 'none', from, to }),
    enabled: Boolean(outletId),
    queryFn: async () =>
      reportingControllerTopItemsStatus200Schema.parse(
        await reportingControllerTopItems({
          path: { id: outletId! },
          query: { from: fromInstant, to: toInstant, limit: 5 },
        }),
      ),
  })

  if (!hasPermission(session.user, 'reports.read')) {
    return (
      <main className="page-wrap py-10">
        <p role="alert" className="m-0 text-sm text-error">
          You do not have permission to view reports.
        </p>
      </main>
    )
  }

  function applyWindow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (new Date(draft.to) <= new Date(draft.from)) {
      setError('The window end must be after the window start.')
      return
    }
    setError(null)
    void navigate({
      to: '/reports',
      search: (prev) => ({
        from: draft.from,
        to: draft.to,
        outletId: prev.outletId,
      }),
    })
  }

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Reporting</p>
      <h1 className="mb-2 font-display text-display-md text-ink">
        Revenue by outlet
      </h1>
      <p className="mb-6 text-sm text-body">
        {from} → {to} (UTC, end exclusive) · computed from accepted sales in HQ
        projections.
      </p>

      <form
        onSubmit={applyWindow}
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-xs font-semibold">
          From (inclusive)
          <input
            type="date"
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
            className="form-input font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          To (exclusive)
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            className="form-input font-normal"
          />
        </label>
        <button type="submit" className="btn-primary btn-sm">
          Apply window
        </button>
        {error ? (
          <p role="alert" className="m-0 text-xs text-error">
            {error}
          </p>
        ) : null}
      </form>

      <section className="card-panel p-6">
        {revenue.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading revenue…
          </p>
        ) : revenue.isError ? (
          <p role="alert" className="m-0 text-sm text-error">
            {revenue.error instanceof ApiError
              ? `${revenue.error.code}: ${revenue.error.message}`
              : 'Failed to load revenue.'}
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="badge-pill badge-neutral">
                  Data as of {formatInstantUtc(revenue.data.dataAsOf)}
                </span>
                {revenue.data.isProvisional ? (
                  <span className="badge-pill badge-error">
                    provisional — outlets may have unsynced sales
                  </span>
                ) : (
                  <span className="badge-pill badge-success">final</span>
                )}
              </div>
              <p className="money m-0 text-sm font-medium text-ink">
                Total{' '}
                {formatMinor(
                  revenue.data.totalRevenueMinor,
                  revenue.data.currencyCode,
                )}
              </p>
            </div>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline-soft text-left">
                  <th className="kicker py-2 pr-4 font-semibold">Outlet</th>
                  <th className="kicker py-2 pr-4 text-right font-semibold">
                    Revenue
                  </th>
                  <th className="kicker py-2 pr-4 text-right font-semibold">
                    Sales
                  </th>
                  <th className="kicker py-2 font-semibold">Last reported</th>
                </tr>
              </thead>
              <tbody>
                {revenue.data.outlets.map((row) => (
                  <tr
                    key={row.outletId}
                    className="border-b border-hairline-soft"
                  >
                    <td className="py-2 pr-4 font-medium text-ink">
                      {row.outletName}
                    </td>
                    <td className="money py-2 pr-4 text-right">
                      {formatMinor(
                        row.totalRevenueMinor,
                        revenue.data.currencyCode,
                      )}
                    </td>
                    <td className="money py-2 pr-4 text-right">
                      {row.completedSaleCount}
                    </td>
                    <td className="py-2">
                      {row.lastIngestedAt ? (
                        <span className="text-body">
                          {formatInstantUtc(row.lastIngestedAt)}
                        </span>
                      ) : (
                        <span className="badge-pill badge-neutral">
                          never reported
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="m-0 mt-4 text-xs text-muted-foreground">
              Every active outlet is listed even with zero sales — a blank or
              stale contribution means unsynced data, never “no sales” (AT-20).
            </p>
          </>
        )}
      </section>

      <section className="card-panel mt-6 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 font-display text-title-md text-ink">Top items</h2>
          {outlets.data && outlets.data.length > 0 ? (
            <label className="flex items-center gap-2 text-xs font-semibold">
              Outlet
              <select
                value={outletId ?? ''}
                onChange={(event) =>
                  void navigate({
                    to: '/reports',
                    search: (prev) => ({
                      from: prev.from ?? from,
                      to: prev.to ?? to,
                      outletId: event.target.value,
                    }),
                  })
                }
                className="form-input font-normal"
              >
                {outlets.data
                  .filter((outlet) => outlet.status === 'ACTIVE')
                  .map((outlet) => (
                    <option key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>

        {!outletId ? (
          <p className="m-0 text-sm text-body">
            Select an outlet to rank its top items.
          </p>
        ) : topItems.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading top items…
          </p>
        ) : topItems.isError ? (
          <p role="alert" className="m-0 text-sm text-error">
            {topItems.error instanceof ApiError
              ? `${topItems.error.code}: ${topItems.error.message}`
              : 'Failed to load top items.'}
          </p>
        ) : (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline-soft text-left">
                  <th className="kicker py-2 pr-4 font-semibold">#</th>
                  <th className="kicker py-2 pr-4 font-semibold">Item</th>
                  <th className="kicker py-2 text-right font-semibold">Sold</th>
                </tr>
              </thead>
              <tbody>
                {topItems.data.items.map((item) => (
                  <tr
                    key={item.menuItemId}
                    className="border-b border-hairline-soft"
                  >
                    <td className="money py-2 pr-4 text-muted-foreground">
                      {item.rank}
                    </td>
                    <td className="py-2 pr-4 font-medium text-ink">
                      {item.itemName}
                    </td>
                    <td className="money py-2 text-right">
                      {item.quantitySold}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="m-0 mt-4 text-xs text-muted-foreground">
              Window {from} → {to} (UTC) · data as of{' '}
              {formatInstantUtc(topItems.data.dataAsOf)} · max 5 in V1.
            </p>
          </>
        )}
      </section>
    </main>
  )
}
