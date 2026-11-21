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
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          You do not have permission to view sales history.
        </p>
      </main>
    )
  }

  const rows = pages.data?.pages.flatMap((page) => page.rows) ?? []

  return (
    <main className="page-wrap py-10">
      <p className="island-kicker mb-2">Register history</p>
      <h1 className="mb-1 text-2xl font-semibold text-[var(--sea-ink)]">
        Sales
      </h1>
      <p className="mb-4 mt-1 text-sm text-[var(--sea-ink-soft)]">
        Local receipts only. Server-computed totals; snapshots are immutable.
      </p>

      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
          From
          <input
            type="date"
            className="mt-1 block rounded-lg border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-[var(--sea-ink)]"
            value={range.from ? range.from.slice(0, 10) : ''}
            onChange={(event) => onFromChange(event.target.value)}
          />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
          To
          <input
            type="date"
            className="mt-1 block rounded-lg border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm font-normal normal-case tracking-normal text-[var(--sea-ink)]"
            value={range.to ? range.to.slice(0, 10) : ''}
            onChange={(event) => onToChange(event.target.value)}
          />
        </label>
        {range.from || range.to ? (
          <button
            type="button"
            className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold text-[var(--sea-ink)]"
            onClick={() => applyRange({ from: undefined, to: undefined })}
          >
            Clear dates
          </button>
        ) : null}
      </form>

      {pages.isPending ? (
        <p
          className="island-shell rounded-2xl p-6 text-sm text-[var(--sea-ink-soft)]"
          aria-busy="true"
        >
          Loading sales…
        </p>
      ) : pages.isError ? (
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          History unavailable:{' '}
          {pages.error instanceof Error ? pages.error.message : 'network error'}
        </p>
      ) : rows.length === 0 ? (
        <p className="island-shell rounded-2xl p-6 text-sm text-[var(--sea-ink-soft)]">
          No sales in this window yet.
        </p>
      ) : (
        <section className="island-shell overflow-x-auto rounded-2xl p-6">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
                <th className="py-2 pr-4">Receipt</th>
                <th className="py-2 pr-4">Sold at</th>
                <th className="py-2 pr-4">Lines</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((sale) => (
                <tr key={sale.id} className="border-b border-[var(--line)]/60">
                  <td className="py-2 pr-4">
                    <Link
                      to="/sales/$saleId"
                      params={{ saleId: sale.id }}
                      className="font-mono font-semibold text-[var(--lagoon-deep)] underline decoration-dotted"
                    >
                      {sale.receiptNo}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-[var(--sea-ink-soft)]">
                    {new Date(sale.soldAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">{sale.lineCount}</td>
                  <td className="py-2 pr-4 text-xs font-semibold text-[#1d7a3f]">
                    {sale.status}
                  </td>
                  <td className="py-2 text-right font-mono font-semibold">
                    {formatMinor(sale.totalMinor, sale.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages.hasNextPage ? (
            <button
              type="button"
              className="mt-4 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold text-[var(--sea-ink)] disabled:opacity-50"
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
