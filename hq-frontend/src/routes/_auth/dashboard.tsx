import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { outletsControllerListOutletsQueryOptions } from '#/api/generated/queries/useOutletsControllerListOutlets'
import { ApiError } from '#/api/axios'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'

export const Route = createFileRoute('/_auth/dashboard')({
  component: DashboardPage,
})

function useOutlets() {
  // queryOptions() already carries the queryKey — never spread a second one
  // over it (TS2783).
  return useQuery(outletsControllerListOutletsQueryOptions())
}

function DashboardPage() {
  const session = useSession()
  const outlets = useOutlets()

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

      <section className="card-panel p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="m-0 font-display text-title-md text-ink">Outlets</h2>
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
            {outlets.data.map((outlet) => (
              <Link
                key={outlet.id}
                to="/outlets/$outletId"
                params={{ outletId: outlet.id }}
                className="feature-card p-4 no-underline"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="badge-pill">{outlet.code}</span>
                  <span className="money text-xs font-medium text-muted-foreground">
                    rev {outlet.catalogRevision}
                  </span>
                </div>
                <p className="m-0 text-sm font-medium text-ink">
                  {outlet.name}
                </p>
                <p className="m-0 mt-1 text-xs text-body">
                  {outlet.timezone} · {outlet.status}
                </p>
              </Link>
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
        </div>
        <p className="m-0 mt-4 text-xs text-muted-foreground">
          Cross-outlet revenue reporting arrives in Phase 4 with explicit
          data-freshness indicators (PRD §10, §18).
        </p>
      </section>
    </main>
  )
}
