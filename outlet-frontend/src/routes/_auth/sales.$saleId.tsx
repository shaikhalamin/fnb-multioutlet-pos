import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { fetchSale } from '#/features/sales/api'
import { salesKeys } from '#/features/sales/keys'
import { formatMinor } from '#/lib/utils'

export const Route = createFileRoute('/_auth/sales/$saleId')({
  component: SaleDetailPage,
})

/** Receipt detail with immutable line snapshots (FR-02, AT-19) + reprint. */
function SaleDetailPage() {
  const { saleId } = Route.useParams()
  const sale = useQuery({
    queryKey: salesKeys.detail(saleId),
    queryFn: () => fetchSale(saleId),
  })

  if (sale.isPending) {
    return (
      <main
        className="page-wrap py-16 text-sm text-[var(--sea-ink-soft)]"
        aria-busy="true"
      >
        Loading receipt…
      </main>
    )
  }
  if (sale.isError) {
    return (
      <main className="page-wrap py-16">
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          {sale.error instanceof Error
            ? sale.error.message
            : 'Receipt unavailable.'}
        </p>
        <p className="mt-3 text-sm">
          <Link to="/sales" className="text-[var(--lagoon-deep)] underline">
            ← Back to sales
          </Link>
        </p>
      </main>
    )
  }

  const data = sale.data
  return (
    <main className="page-wrap py-10">
      <p className="mb-3 text-sm print:hidden">
        <Link to="/sales" className="text-[var(--lagoon-deep)] underline">
          ← Back to sales
        </Link>
      </p>

      <section className="island-shell mx-auto max-w-xl rounded-2xl p-6 print:border-0 print:shadow-none">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="island-kicker m-0">Receipt</p>
          <span className="rounded-full bg-[rgba(52,199,89,0.15)] px-3 py-1 text-xs font-semibold text-[#1d7a3f]">
            {data.status} · sync {data.syncStatus}
          </span>
        </div>
        <h1 className="m-0 mb-1 font-mono text-3xl font-bold text-[var(--sea-ink)]">
          {data.receiptNo}
        </h1>
        <p className="m-0 mb-5 text-xs text-[var(--sea-ink-soft)]">
          Sold {new Date(data.soldAt).toLocaleString()} · catalog revision{' '}
          {data.catalogRevision} · {data.currencyCode}
        </p>

        <table className="mb-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <th className="py-2 pr-3">Item</th>
              <th className="py-2 pr-3">Qty</th>
              <th className="py-2 pr-3">Unit</th>
              <th className="py-2 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr
                key={item.saleItemId}
                className="border-b border-[var(--line)]/60"
              >
                <td className="py-2 pr-3 font-medium text-[var(--sea-ink)]">
                  {item.name}
                  <span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
                    {item.sku}
                  </span>
                </td>
                <td className="py-2 pr-3">{item.quantity}</td>
                <td className="py-2 pr-3">
                  {formatMinor(item.unitPriceMinor, data.currencyCode)}
                </td>
                <td className="py-2 text-right">
                  {formatMinor(item.subtotalMinor, data.currencyCode)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-3 text-right font-semibold">
                Total
              </td>
              <td className="pt-3 text-right font-mono text-lg font-bold">
                {formatMinor(data.totalMinor, data.currencyCode)}
              </td>
            </tr>
          </tfoot>
        </table>

        <button
          type="button"
          className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white print:hidden"
          onClick={() => window.print()}
        >
          Reprint receipt
        </button>
      </section>
    </main>
  )
}
