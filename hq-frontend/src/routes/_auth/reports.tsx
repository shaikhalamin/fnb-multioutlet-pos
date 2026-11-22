import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { ChangeEvent, FormEvent, HTMLAttributes, ReactNode } from 'react'
import { z } from 'zod'
import { cn } from 'cn'
import { ApiError } from '#/api/axios'
import { outletsControllerListOutletsQueryOptions } from '#/api/generated/queries/useOutletsControllerListOutlets'
import { useSession } from '#/features/auth/session'
import { useOutletTopItems, useRevenueReport } from '#/features/reports/queries'
import { SectionTabs, sectionTabClass } from '#/components/SectionTabs'
import { hasPermission } from '#/lib/permissions'
import {
  formatInstantUtc,
  formatMinor,
  minorToBigInt,
  shareBps,
} from '#/lib/utils'

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
  // The tab on screen lives in the URL, so each report is linkable and
  // survives refresh; anything unknown falls back to the revenue tab.
  tab: z.enum(['revenue', 'top-items']).catch('revenue'),
  from: z.string().regex(dayPattern).catch(defaults.from),
  to: z.string().regex(dayPattern).catch(defaults.to),
  outletId: z.string().uuid().optional().catch(undefined),
})

type ReportTab = z.infer<typeof searchSchema>['tab']

/**
 * Tab links switch only the tab: the applied window and outlet are kept.
 * (`prev` is the router-wide search shape, hence the optional fields.)
 */
function searchWithTab(tab: ReportTab) {
  return (prev: { from?: string; to?: string; outletId?: string }) => ({
    tab,
    from: prev.from ?? defaults.from,
    to: prev.to ?? defaults.to,
    outletId: prev.outletId,
  })
}

/**
 * Current-month window for plain `<Link to="/reports">` navigations; the link
 * adds the tab, e.g. `{ ...defaultReportSearch(), tab: 'revenue' }`.
 */
export function defaultReportSearch(): { from: string; to: string } {
  return monthWindow()
}

export const Route = createFileRoute('/_auth/reports')({
  validateSearch: searchSchema.parse,
  component: ReportsPage,
})

function ReportsPage() {
  const session = useSession()
  const { tab, from, to, outletId: outletParam } = Route.useSearch()

  if (!hasPermission(session.user, 'reports.read')) {
    return (
      <main className="page-wrap py-10">
        <p role="alert" className="m-0 text-sm text-error">
          You do not have permission to view reports.
        </p>
      </main>
    )
  }

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Reporting</p>
      <h1 className="mb-2 font-display text-display-md text-ink">Reports</h1>
      <p className="mb-6 text-sm text-body">
        Revenue and top-selling items across your outlets, computed from
        accepted sales in HQ projections. Windows are whole UTC days and the end
        date is exclusive.
      </p>

      {/* Keyed by the applied window: a URL change (browser back, a link)
          resets the draft inputs so they never show an unapplied window. */}
      <WindowForm key={`${from}/${to}`} from={from} to={to} tab={tab} />

      <SectionTabs label="Report sections" className="mb-6">
        <Link
          to="/reports"
          search={searchWithTab('revenue')}
          aria-current={tab === 'revenue' ? 'page' : undefined}
          className={sectionTabClass(tab === 'revenue')}
        >
          Total revenue by outlet
        </Link>
        <Link
          to="/reports"
          search={searchWithTab('top-items')}
          aria-current={tab === 'top-items' ? 'page' : undefined}
          className={sectionTabClass(tab === 'top-items')}
        >
          Top 5 selling items per outlet
        </Link>
      </SectionTabs>

      {tab === 'revenue' ? (
        <RevenueTab from={from} to={to} />
      ) : (
        <TopItemsTab from={from} to={to} outletParam={outletParam} />
      )}
    </main>
  )
}

/**
 * The shared date window. It scopes both tabs, so it sits above them and is
 * kept when the user switches tabs.
 */
function WindowForm({
  from,
  to,
  tab,
}: {
  from: string
  to: string
  tab: ReportTab
}) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState({ from, to })
  const [error, setError] = useState<string | null>(null)

  function applyWindow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Both values are `YYYY-MM-DD` once the pattern check passes, so the
    // plain string comparison below is also the chronological order.
    if (!dayPattern.test(draft.from) || !dayPattern.test(draft.to)) {
      setError('Choose both a start and an end date.')
      return
    }
    if (draft.to <= draft.from) {
      setError('The window end must be after the window start.')
      return
    }
    setError(null)
    void navigate({
      to: '/reports',
      search: (prev) => ({
        tab,
        from: draft.from,
        to: draft.to,
        outletId: prev.outletId,
      }),
    })
  }

  const fieldProps = {
    'aria-invalid': error !== null,
    'aria-describedby': error ? 'report-window-error' : undefined,
  }

  return (
    <form
      onSubmit={applyWindow}
      aria-label="Report date window"
      className="mb-6 flex flex-wrap items-end gap-3"
    >
      <label className="flex flex-col gap-1 text-xs font-semibold">
        From (inclusive)
        <input
          type="date"
          value={draft.from}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          {...fieldProps}
          className="form-input font-normal"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold">
        To (exclusive)
        <input
          type="date"
          value={draft.to}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          {...fieldProps}
          className="form-input font-normal"
        />
      </label>
      <button type="submit" className="btn-primary">
        Apply window
      </button>
      {error ? (
        <p
          id="report-window-error"
          role="alert"
          className="m-0 basis-full text-xs text-error"
        >
          {error}
        </p>
      ) : null}
    </form>
  )
}

function RevenueTab({ from, to }: { from: string; to: string }) {
  const revenue = useRevenueReport(from, to)

  // Ranked biggest-first so the share bars taper; the API lists outlets by
  // code, which stays as the tie-break.
  const rows = revenue.data
    ? [...revenue.data.outlets].sort(
        (a, b) =>
          compareMinorDesc(a.totalRevenueMinor, b.totalRevenueMinor) ||
          a.outletName.localeCompare(b.outletName),
      )
    : []

  return (
    <section className="card-panel p-6" aria-busy={revenue.isFetching}>
      <h2 className="sr-only">Total revenue by outlet</h2>

      {revenue.isPending ? (
        <>
          <p role="status" className="sr-only">
            Loading revenue…
          </p>
          <div aria-hidden="true">
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-6 w-16" />
            </div>
            <p className="kicker m-0">Total revenue</p>
            <Skeleton className="mt-1 h-10 w-44" />
            <Skeleton className="mt-1 h-4 w-56" />
            <RevenueTable caption="Revenue by outlet">
              {SKELETON_ROWS.map((row) => (
                <tr
                  key={row}
                  className="border-b border-hairline-soft last:border-b-0"
                >
                  <th scope="row" className="py-3 pr-4">
                    <Skeleton className="h-5 w-32" />
                  </th>
                  <td className="py-3 pr-4">
                    <Skeleton className="ml-auto h-5 w-20" />
                  </td>
                  <td className="py-3 pr-4">
                    <span className="flex items-center gap-3">
                      <span className="h-1.5 min-w-24 flex-1 animate-pulse rounded-full bg-surface-strong motion-reduce:animate-none!" />
                      <Skeleton className="h-4 w-9 shrink-0" />
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <Skeleton className="ml-auto h-5 w-8" />
                  </td>
                  <td className="py-3">
                    <Skeleton className="h-5 w-36" />
                  </td>
                </tr>
              ))}
            </RevenueTable>
          </div>
        </>
      ) : revenue.isError ? (
        <ReportError
          error={revenue.error}
          fallback="Failed to load revenue."
          onRetry={() => void revenue.refetch()}
          retrying={revenue.isFetching}
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <DataAsOfBadge dataAsOf={revenue.data.dataAsOf} />
            <ProvisionalBadge provisional={revenue.data.isProvisional} />
          </div>
          <p className="kicker m-0">Total revenue</p>
          <p className="money m-0 mt-1 font-display text-display-lg text-ink">
            {formatMinor(
              revenue.data.totalRevenueMinor,
              revenue.data.currencyCode,
            )}
          </p>
          <p className="m-0 mt-1 text-xs text-body">
            {from} → {to} · UTC, end date exclusive
          </p>
          <RevenueTable caption={`Revenue by outlet, ${from} to ${to} UTC`}>
            {rows.map((row) => (
              <tr
                key={row.outletId}
                className="border-b border-hairline-soft last:border-b-0"
              >
                <th
                  scope="row"
                  className="py-3 pr-4 text-left font-medium text-ink"
                >
                  {row.outletName}
                </th>
                {/* An outlet that never reported has no trustworthy figure,
                    so its zero is dimmed rather than presented as revenue. */}
                <td
                  className={cn(
                    'money whitespace-nowrap py-3 pr-4 text-right',
                    row.lastIngestedAt === null && 'text-muted-foreground',
                  )}
                >
                  {formatMinor(
                    row.totalRevenueMinor,
                    revenue.data.currencyCode,
                  )}
                </td>
                <td className="py-3 pr-4">
                  <ShareBar
                    value={row.totalRevenueMinor}
                    total={revenue.data.totalRevenueMinor}
                  />
                </td>
                <td className="money whitespace-nowrap py-3 pr-4 text-right">
                  {row.completedSaleCount}
                </td>
                <td className="py-3">
                  {row.lastIngestedAt ? (
                    <span className="text-body">
                      {formatInstantUtc(row.lastIngestedAt)}
                    </span>
                  ) : (
                    // Tighter padding keeps this row the same height as the
                    // ones with a plain timestamp.
                    <span className="badge-pill badge-neutral py-0.5">
                      never reported
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </RevenueTable>
          <p className="m-0 mt-4 text-xs text-muted-foreground">
            Every active outlet is listed even with zero sales — a blank or
            stale contribution means unsynced data, never “no sales”.
          </p>
        </>
      )}
    </section>
  )
}

function TopItemsTab({
  from,
  to,
  outletParam,
}: {
  from: string
  to: string
  outletParam: string | undefined
}) {
  const navigate = useNavigate()
  const outlets = useQuery(outletsControllerListOutletsQueryOptions())
  const activeOutlets =
    outlets.data?.filter((outlet) => outlet.status === 'ACTIVE') ?? []

  // The outlet on screen: the URL's outlet — trusted before the list arrives
  // so the ranking loads in parallel with it — else the first active one.
  // Once the list is in, an outlet that is no longer active falls back too,
  // so the dropdown can never show one outlet while ranking another.
  const outletId =
    outletParam !== undefined &&
    (outlets.isPending ||
      activeOutlets.some((outlet) => outlet.id === outletParam))
      ? outletParam
      : (activeOutlets.at(0)?.id ?? null)

  const topItems = useOutletTopItems(outletId, from, to)
  // The same query the Revenue tab reads (shared cache): here it only
  // supplies the selected outlet's watermark and the provisional flag.
  const revenue = useRevenueReport(from, to)
  const provisional = revenue.data?.isProvisional ?? null
  const outletRow = revenue.data?.outlets.find(
    (row) => row.outletId === outletId,
  )
  const neverReported =
    outletRow !== undefined && outletRow.lastIngestedAt === null
  const outletName =
    activeOutlets.find((outlet) => outlet.id === outletId)?.name ??
    'This outlet'

  function selectOutlet(event: ChangeEvent<HTMLSelectElement>) {
    void navigate({
      to: '/reports',
      search: (prev) => ({
        tab: 'top-items',
        from: prev.from ?? from,
        to: prev.to ?? to,
        outletId: event.target.value,
      }),
    })
  }

  return (
    <section className="card-panel p-6" aria-busy={topItems.isFetching}>
      <h2 className="sr-only">Top 5 selling items per outlet</h2>

      {outlets.isPending ? (
        <>
          <p role="status" className="sr-only">
            Loading outlets…
          </p>
          <div aria-hidden="true">
            <TopItemsToolbar>
              <div className="flex flex-col gap-1">
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-11 w-64" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-6 w-40" />
              </div>
            </TopItemsToolbar>
            <RankingSkeleton />
          </div>
        </>
      ) : outlets.isError ? (
        <ReportError
          error={outlets.error}
          fallback="Failed to load outlets."
          onRetry={() => void outlets.refetch()}
          retrying={outlets.isFetching}
        />
      ) : activeOutlets.length === 0 ? (
        <p className="m-0 text-sm text-body">
          No active outlets yet — provision one from the Outlets page first.
        </p>
      ) : (
        <>
          <TopItemsToolbar>
            <label className="flex flex-col gap-1 text-xs font-semibold">
              Outlet
              <select
                value={outletId ?? ''}
                onChange={selectOutlet}
                className="form-input w-64 font-normal"
              >
                {activeOutlets.map((outlet) => (
                  <option key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {topItems.isPending ? (
                <Skeleton className="h-6 w-48" />
              ) : topItems.isError ? null : (
                <DataAsOfBadge dataAsOf={topItems.data.dataAsOf} />
              )}
              {revenue.isPending ? (
                <Skeleton className="h-6 w-40" />
              ) : revenue.isError ? (
                <span className="badge-pill badge-neutral">
                  sync status unavailable
                </span>
              ) : (
                <>
                  <ProvisionalBadge provisional={provisional === true} />
                  {neverReported ? (
                    <span className="badge-pill badge-neutral">
                      never reported
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </TopItemsToolbar>

          {topItems.isPending ? (
            <>
              <p role="status" className="sr-only">
                Loading top items…
              </p>
              <div aria-hidden="true">
                <RankingSkeleton />
              </div>
            </>
          ) : topItems.isError ? (
            <ReportError
              error={topItems.error}
              fallback="Failed to load top items."
              onRetry={() => void topItems.refetch()}
              retrying={topItems.isFetching}
            />
          ) : topItems.data.items.length === 0 ? (
            <EmptyRanking
              outletName={outletName}
              neverReported={neverReported}
              provisional={provisional}
            />
          ) : (
            <>
              {/* The list itself carries the order, so the visible rank
                  numbers stay out of the accessibility tree. */}
              <ol className="m-0 list-none p-0">
                {topItems.data.items.map((item) => (
                  <li
                    key={item.menuItemId}
                    className="border-b border-hairline-soft py-3 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="flex min-w-0 items-baseline gap-3">
                        <span
                          aria-hidden="true"
                          className="money w-4 shrink-0 text-sm text-muted-foreground"
                        >
                          {item.rank}
                        </span>
                        <span className="truncate font-medium text-ink">
                          {item.itemName}
                        </span>
                      </span>
                      <span className="money shrink-0 text-sm text-body">
                        <span className="font-medium text-ink">
                          {item.quantitySold}
                        </span>{' '}
                        sold
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      className="ml-7 mt-2 h-2 overflow-hidden rounded-full bg-surface-strong"
                    >
                      <div
                        className="h-full rounded-full bg-ink"
                        style={{
                          width: `${barWidth(
                            item.quantitySold,
                            topItems.data.items.at(0)?.quantitySold,
                          )}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ol>
              <p className="m-0 mt-4 text-xs text-muted-foreground">
                {from} → {to} (UTC) · bars are scaled to the top seller · top 5
                in V1.
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}

const SKELETON_ROWS = [0, 1, 2, 3]
const RANK_SKELETON_WIDTHS = ['w-full', 'w-4/5', 'w-3/5', 'w-2/5', 'w-1/3']

function TopItemsToolbar({
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        'mb-6 flex flex-wrap items-end gap-x-6 gap-y-3',
        rest.className,
      )}
    >
      {children}
    </div>
  )
}

/** Five placeholder rows — the ranking's full height, so nothing jumps. */
function RankingSkeleton() {
  return (
    <ol className="m-0 list-none p-0">
      {RANK_SKELETON_WIDTHS.map((width) => (
        <li
          key={width}
          className="border-b border-hairline-soft py-3 first:pt-0 last:border-b-0 last:pb-0"
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="flex items-baseline gap-3">
              <Skeleton className="h-5 w-4" />
              <Skeleton className="h-5 w-40" />
            </span>
            <Skeleton className="h-5 w-14" />
          </div>
          <Skeleton className={cn('mt-2 h-2', width)} />
        </li>
      ))}
    </ol>
  )
}

function RevenueTable({
  caption,
  children,
}: {
  caption: string
  children: ReactNode
}) {
  return (
    <div className="mt-5 overflow-x-auto">
      {/* Fixed column widths: in an auto-layout table a column sized by its
          bar squeezes every other column down to its minimum. Below 40rem the
          table scrolls sideways instead of collapsing. */}
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col />
          <col className="w-[18%]" />
          <col className="w-[28%]" />
          <col className="w-[9%]" />
          <col className="w-[24%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-hairline text-left">
            <th scope="col" className="kicker py-2 pr-4 font-semibold">
              Outlet
            </th>
            <th
              scope="col"
              className="kicker py-2 pr-4 text-right font-semibold"
            >
              Revenue
            </th>
            <th scope="col" className="kicker py-2 pr-4 font-semibold">
              Share of total
            </th>
            <th
              scope="col"
              className="kicker py-2 pr-4 text-right font-semibold"
            >
              Sales
            </th>
            <th scope="col" className="kicker py-2 font-semibold">
              Last reported
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {/* Below ~720px the table is wider than the card and scrolls sideways;
          touch devices show no scrollbar, so say it. */}
      <p className="mt-3 text-xs text-muted-foreground min-[720px]:hidden">
        Scroll the table sideways to see every column →
      </p>
    </div>
  )
}

/**
 * Proportional bar plus the rounded share as text — the bar is decoration, so
 * the share is never conveyed by length alone. A zero total has no shares.
 */
function ShareBar({ value, total }: { value: string; total: string }) {
  const bps = shareBps(value, total)
  if (bps === null) {
    return <span className="money text-muted-foreground">—</span>
  }
  return (
    <span className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-strong"
      >
        <span
          className="block h-full rounded-full bg-ink"
          style={{ width: `${bps / 100}%` }}
        />
      </span>
      <span className="money w-9 shrink-0 text-right text-xs text-body">
        {Math.round(bps / 100)}%
      </span>
    </span>
  )
}

/** Bar length of a ranked item, as a percentage of the outlet's top seller. */
function barWidth(quantity: number, top: number | undefined): number {
  return top ? Math.round((quantity / top) * 1000) / 10 : 0
}

/** Descending order for minor-unit strings; a non-canonical value sorts last. */
function compareMinorDesc(a: string, b: string): number {
  const left = minorToBigInt(a)
  const right = minorToBigInt(b)
  if (left === right) return 0
  return left === null || (right !== null && left < right) ? 1 : -1
}

/** Reserved-space placeholder while a report loads, so nothing jumps. */
function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-full bg-surface-strong motion-reduce:animate-none!',
        className,
      )}
    />
  )
}

/**
 * Freshness disclosure every report view must carry (AGENTS §13, AT-20):
 * stale data must never read as "zero sales".
 */
function DataAsOfBadge({ dataAsOf }: { dataAsOf: string | null }) {
  return (
    <span className="badge-pill badge-neutral">
      {dataAsOf
        ? `Data as of ${formatInstantUtc(dataAsOf)}`
        : 'No sales reported yet'}
    </span>
  )
}

function ProvisionalBadge({ provisional }: { provisional: boolean }) {
  return provisional ? (
    <span className="badge-pill badge-error">
      provisional — outlets may have unsynced sales
    </span>
  ) : (
    <span className="badge-pill badge-success">final</span>
  )
}

/** Load failure with a way back: the stable error code plus a retry. */
function ReportError({
  error,
  fallback,
  onRetry,
  retrying,
}: {
  error: unknown
  fallback: string
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="m-0 text-sm text-error">
        {error instanceof ApiError
          ? `${error.code}: ${error.message}`
          : fallback}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="btn-outline btn-sm"
      >
        Try again
      </button>
    </div>
  )
}

function EmptyRanking({
  outletName,
  neverReported,
  provisional,
}: {
  outletName: string
  neverReported: boolean
  /** The report's provisional flag; null when it could not be loaded. */
  provisional: boolean | null
}) {
  const title = neverReported
    ? `${outletName} has never reported a sale`
    : `Nothing sold at ${outletName} in this window`
  const body = neverReported
    ? 'There is nothing to rank yet — this is missing data, not zero sales. Check that the outlet is paired and its sync worker is running.'
    : provisional
      ? 'The report is provisional — this outlet may still have unsynced sales, so read this as incomplete rather than zero.'
      : provisional === false
        ? 'No completed sales from this outlet were recorded in this period, and no outlet reported unsynced sales.'
        : 'No completed sales from this outlet were recorded in this period.'

  return (
    <div className="rounded-xl border border-hairline bg-canvas-soft px-4 py-6 text-center">
      <p className="m-0 font-display text-title-md text-ink">{title}</p>
      <p className="m-0 mt-1 text-sm text-body">{body}</p>
    </div>
  )
}
