import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { outletsControllerListOutletsQueryOptions } from '#/api/generated/queries/useOutletsControllerListOutlets'
import { syncAdminControllerGetSyncStatusQueryOptions } from '#/api/generated/queries/useSyncAdminControllerGetSyncStatus'
import { reportingControllerRevenueByOutlet } from '#/api/generated/clients/reportingControllerRevenueByOutlet'
import { reportingControllerRevenueByOutletStatus200Schema } from '#/api/generated/schemas/reportingControllerRevenueByOutletSchema'
import type { OutletResponse } from '#/api/generated/types/OutletResponse'
import { ApiError } from '#/api/axios'
import { useSession } from '#/features/auth/session'
import { reportKeys } from '#/features/reports/keys'
import { hasPermission } from '#/lib/permissions'
import { formatInstantUtc, formatMinor } from '#/lib/utils'
import { defaultReportSearch } from './reports'

export const Route = createFileRoute('/_auth/dashboard')({
  component: DashboardPage,
})

function useOutlets() {
  // queryOptions() already carries the queryKey — never spread a second one
  // over it (TS2783).
  return useQuery(outletsControllerListOutletsQueryOptions())
}

/** A heartbeat older than this means the outlet worker is not phoning home. */
const STALE_HEARTBEAT_MS = 5 * 60 * 1000

function DashboardPage() {
  const session = useSession()
  const outlets = useOutlets()
  const canReadReports = hasPermission(session.user, 'reports.read')
  const canReadSync = hasPermission(session.user, 'sync.read')

  // Current calendar month, UTC — the same window the reports page opens on.
  const window = useMemo(() => defaultReportSearch(), [])

  const revenue = useQuery({
    queryKey: reportKeys.revenue(window),
    enabled: canReadReports,
    queryFn: async () =>
      reportingControllerRevenueByOutletStatus200Schema.parse(
        await reportingControllerRevenueByOutlet({
          query: {
            from: `${window.from}T00:00:00Z`,
            to: `${window.to}T00:00:00Z`,
          },
        }),
      ),
  })

  return (
    <main className="page-wrap py-10">
      <div className="relative mb-8">
        <span
          aria-hidden="true"
          className="orb orb-sky -top-10 right-0 h-48 w-48"
        />
        <p className="kicker relative mb-2">HQ Console</p>
        <h1 className="relative m-0 font-display text-display-md text-ink">
          Welcome back{session.user ? `, ${session.user.email}` : ''}
        </h1>
      </div>

      {canReadReports ? (
        <section className="card-panel mb-6 p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="kicker mb-1">
                Revenue · {window.from} → {window.to} (UTC)
              </p>
              <p className="money m-0 font-display text-display-lg text-ink">
                {revenue.isPending
                  ? '…'
                  : revenue.isError
                    ? '—'
                    : formatMinor(
                        revenue.data.totalRevenueMinor,
                        revenue.data.currencyCode,
                      )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {revenue.isError ? null : (
                <span className="badge-pill badge-neutral">
                  data as of {formatInstantUtc(revenue.data?.dataAsOf)}
                </span>
              )}
              {revenue.data?.isProvisional ? (
                <span className="badge-pill badge-error">
                  provisional — outlets may have unsynced sales
                </span>
              ) : revenue.data ? (
                <span className="badge-pill badge-success">final</span>
              ) : null}
            </div>
          </div>
          {revenue.isError ? (
            <p role="alert" className="m-0 text-sm text-error">
              {revenue.error instanceof ApiError
                ? `${revenue.error.code}: ${revenue.error.message}`
                : 'Failed to load revenue.'}
            </p>
          ) : (
            <Link to="/reports" search={window} className="nav-link text-xs">
              Open reports with date filters →
            </Link>
          )}
        </section>
      ) : null}

      <section className="card-panel p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="m-0 font-display text-title-md text-ink">
            Outlet health
          </h2>
          {hasPermission(session.user, 'outlets.read') ? (
            <Link to="/outlets" className="nav-link text-xs">
              Manage outlets →
            </Link>
          ) : null}
        </div>

        {outlets.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading outlets…
          </p>
        ) : outlets.isError ? (
          <p role="alert" className="m-0 text-sm text-error">
            {outlets.error instanceof ApiError
              ? `${outlets.error.code}: ${outlets.error.message}`
              : 'Failed to load outlets.'}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {outlets.data
              .filter((outlet) => outlet.status === 'ACTIVE')
              .map((outlet) => (
                <OutletHealthCard
                  key={outlet.id}
                  outlet={outlet}
                  enabled={canReadSync}
                />
              ))}
          </div>
        )}
      </section>

      <section className="card-panel mt-6 p-6">
        <h2 className="m-0 mb-3 font-display text-title-md text-ink">
          Quick actions
        </h2>
        <div className="flex flex-wrap gap-3">
          {hasPermission(session.user, 'menu.read') ? (
            <Link to="/menu" className="btn-outline btn-sm no-underline">
              Manage master menu
            </Link>
          ) : null}
          {hasPermission(session.user, 'outlets.read') ? (
            <Link to="/outlets" className="btn-outline btn-sm no-underline">
              Assignments &amp; keys
            </Link>
          ) : null}
          {hasPermission(session.user, 'users.read') ? (
            <Link to="/users" className="btn-outline btn-sm no-underline">
              Manage users
            </Link>
          ) : null}
          {canReadReports ? (
            <Link
              to="/reports"
              search={window}
              className="btn-outline btn-sm no-underline"
            >
              Reports
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  )
}

/** One outlet's sync-health tile: watermark, heartbeat and backlog badges. */
function OutletHealthCard({
  outlet,
  enabled,
}: {
  outlet: OutletResponse
  enabled: boolean
}) {
  const status = useQuery({
    ...syncAdminControllerGetSyncStatusQueryOptions({
      path: { id: outlet.id },
    }),
    enabled,
  })

  if (status.isError) {
    return (
      <Link
        to="/outlets/$outletId"
        params={{ outletId: outlet.id }}
        search={{ tab: 'assignments' }}
        className="feature-card p-4 no-underline"
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="badge-pill">{outlet.code}</span>
        </div>
        <p className="m-0 text-sm font-medium text-ink">{outlet.name}</p>
        <p role="alert" className="m-0 mt-1 text-xs text-error">
          {status.error instanceof ApiError
            ? `${status.error.code}: ${status.error.message}`
            : 'Failed to load sync status.'}
        </p>
      </Link>
    )
  }

  const data = status.data
  const pending = data?.lastReportedBacklog?.pendingOutboxCount ?? 0
  const quarantined = data?.quarantinedCount ?? 0
  const heartbeatAgeMs = data?.lastHeartbeatAt
    ? Date.now() - new Date(data.lastHeartbeatAt).getTime()
    : null
  const neverReported = !data || (!data.lastEventAt && !data.lastHeartbeatAt)
  const hasBacklog = pending > 0 || quarantined > 0
  const heartbeatStale =
    heartbeatAgeMs !== null && heartbeatAgeMs > STALE_HEARTBEAT_MS

  return (
    <Link
      to="/outlets/$outletId"
      params={{ outletId: outlet.id }}
      search={{ tab: 'assignments' }}
      className="feature-card p-4 no-underline"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="badge-pill">{outlet.code}</span>
        {status.isPending ? (
          <span className="text-xs text-muted-foreground" aria-busy="true">
            checking…
          </span>
        ) : neverReported ? (
          <span className="badge-pill badge-neutral">never reported</span>
        ) : hasBacklog ? (
          <span className="badge-pill badge-error">
            {pending} pending
            {quarantined > 0 ? ` · ${quarantined} quarantined` : ''}
          </span>
        ) : heartbeatStale ? (
          <span className="badge-pill badge-error">heartbeat stale</span>
        ) : (
          <span className="badge-pill badge-success">healthy</span>
        )}
      </div>
      <p className="m-0 text-sm font-medium text-ink">{outlet.name}</p>
      <dl className="m-0 mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-body">
        <dt className="text-muted-foreground">menu rev</dt>
        <dd className="money m-0">{data ? data.currentMenuRevision : '—'}</dd>
        <dt className="text-muted-foreground">seq watermark</dt>
        <dd className="money m-0">
          {data ? data.highestContiguousSequence : '—'}
        </dd>
        <dt className="text-muted-foreground">last event</dt>
        <dd className="m-0">
          {data?.lastEventAt ? formatInstantUtc(data.lastEventAt) : '—'}
        </dd>
        <dt className="text-muted-foreground">heartbeat</dt>
        <dd className="m-0">
          {data?.lastHeartbeatAt ? formatInstantUtc(data.lastHeartbeatAt) : '—'}
        </dd>
      </dl>
    </Link>
  )
}
