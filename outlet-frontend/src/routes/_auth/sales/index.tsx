import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchSalesPage } from '#/features/sales/api'
import { salesKeys } from '#/features/sales/keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'

/**
 * Sale history search params validated with Zod (AGENTS §4.2): ISO date
 * bounds the backend re-validates.
 */
const searchSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export const Route = createFileRoute('/_auth/sales/')({
  validateSearch: (search) => {
    const parsed = searchSchema.safeParse({
      from: typeof search.from === 'string' ? search.from : undefined,
      to: typeof search.to === 'string' ? search.to : undefined,
    })
    return parsed.success ? parsed.data : {}
  },
  component: SalesPage,
})

function SalesPage() {
  const session = useSession()
  const canRead = hasPermission(session.user, 'sales.read')
  const range = Route.useSearch()
  const navigate = Route.useNavigate()

  const pages = useInfiniteQuery({
    queryKey: salesKeys.list(range),
    queryFn: ({ pageParam }) => fetchSalesPage(range, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })

  // Date filters drive the Zod-validated search params (AGENTS §4.2);
  // `undefined` removes the bound, and whole-day bounds become UTC instants
  // the backend re-validates.
  function applyRange(next: { from?: string; to?: string }): void {
    void navigate({
      to: '.',
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
    })
  }

  function onFromChange(value: string): void {
    applyRange(value ? { from: `${value}T00:00:00.000Z` } : { from: undefined })
  }

  function onToChange(value: string): void {
    applyRange(value ? { to: `${value}T23:59:59.999Z` } : { to: undefined })
  }

  if (!canRead) {
    return (
      <main className="page-wrap py-16">
        <p role="alert" className="card-panel p-6 text-sm text-error">
          You do not have permission to view sales history.
        </p>
      </main>
    )
  }

  const rows = pages.data?.pages.flatMap((page) => page.rows) ?? []

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Register history</p>
      <h1 className="mb-1 font-display text-display-md text-ink">Sales</h1>
      <p className="mb-4 mt-1 text-sm text-body">
        Local receipts only. Server-computed totals; snapshots are immutable.
      </p>

      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="kicker">
          From
          <input
            type="date"
            className="text-input mt-1 block h-9 w-44 font-normal normal-case tracking-normal"
            value={range.from ? range.from.slice(0, 10) : ''}
            onChange={(event) => onFromChange(event.target.value)}
          />
        </label>
        <label className="kicker">
          To
          <input
            type="date"
            className="text-input mt-1 block h-9 w-44 font-normal normal-case tracking-normal"
            value={range.to ? range.to.slice(0, 10) : ''}
            onChange={(event) => onToChange(event.target.value)}
          />
        </label>
        {range.from || range.to ? (
          <button
            type="button"
            className="btn-outline btn-sm"
            onClick={() => applyRange({ from: undefined, to: undefined })}
          >
            Clear dates
          </button>
        ) : null}
      </form>

      {pages.isPending ? (
        <p className="card-panel p-6 text-sm text-body" aria-busy="true">
          Loading sales…
        </p>
      ) : pages.isError ? (
        <p role="alert" className="card-panel p-6 text-sm text-error">
          History unavailable:{' '}
          {pages.error instanceof Error ? pages.error.message : 'network error'}
        </p>
      ) : rows.length === 0 ? (
        <p className="card-panel p-6 text-sm text-body">
          No sales in this window yet.
        </p>
      ) : (
        <section className="card-panel overflow-x-auto p-6">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <th className="kicker py-2 pr-4">Receipt</th>
                <th className="kicker py-2 pr-4">Sold at</th>
                <th className="kicker py-2 pr-4">Lines</th>
                <th className="kicker py-2 pr-4">Status</th>
                <th className="kicker py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((sale) => (
                <tr key={sale.id} className="border-b border-hairline-soft">
                  <td className="money py-2 pr-4">
                    <Link
                      to="/sales/$saleId"
                      params={{ saleId: sale.id }}
                      className="font-semibold underline decoration-dotted"
                    >
                      {sale.receiptNo}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-body">
                    {new Date(sale.soldAt).toLocaleString()}
                  </td>
                  <td className="money py-2 pr-4">{sale.lineCount}</td>
                  <td className="py-2 pr-4 text-xs font-medium text-success">
                    {sale.status}
                  </td>
                  <td className="money py-2 text-right font-semibold">
                    {formatMinor(sale.totalMinor, sale.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages.hasNextPage ? (
            <button
              type="button"
              className="btn-outline btn-sm mt-4"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </section>
      )}
    </main>
  )
}
