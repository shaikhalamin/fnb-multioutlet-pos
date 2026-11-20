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
      <p className="island-kicker mb-2">HQ Console</p>
      <h1 className="mb-6 text-2xl font-semibold text-[var(--sea-ink)]">
        Welcome back{session.user ? `, ${session.user.email}` : ''}
      </h1>

      <section className="island-shell rounded-2xl p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="m-0 text-base font-semibold text-[var(--sea-ink)]">
            Outlets
          </h2>
          {hasPermission(session.user, 'outlets.read') ? (
            <Link to="/outlets" className="nav-link text-xs">
              Manage outlets →
            </Link>
          ) : null}
        </div>

        {outlets.isPending ? (
          <p
            className="m-0 text-sm text-[var(--sea-ink-soft)]"
            aria-busy="true"
          >
            Loading outlets…
          </p>
        ) : outlets.isError ? (
          <p role="alert" className="m-0 text-sm text-[#a03030]">
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
                className="rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] p-4 no-underline transition hover:border-[#56c6be]"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="rounded-full bg-[rgba(86,198,190,0.16)] px-2.5 py-0.5 text-xs font-semibold text-[#2f8f83]">
                    {outlet.code}
                  </span>
                  <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                    rev {outlet.catalogRevision}
                  </span>
                </div>
                <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                  {outlet.name}
                </p>
                <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">
                  {outlet.timezone} · {outlet.status}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="island-shell mt-6 rounded-2xl p-6">
        <h2 className="m-0 mb-3 text-base font-semibold text-[var(--sea-ink)]">
          Quick actions
        </h2>
        <div className="flex flex-wrap gap-3 text-sm">
          {hasPermission(session.user, 'menu.read') ? (
            <Link
              to="/menu"
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 font-semibold text-[var(--sea-ink)] no-underline"
            >
              Manage master menu
            </Link>
          ) : null}
          {hasPermission(session.user, 'outlets.read') ? (
            <Link
              to="/outlets"
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 font-semibold text-[var(--sea-ink)] no-underline"
            >
              Assignments &amp; keys
            </Link>
          ) : null}
          {hasPermission(session.user, 'users.read') ? (
            <Link
              to="/users"
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 font-semibold text-[var(--sea-ink)] no-underline"
            >
              Manage users
            </Link>
          ) : null}
        </div>
        <p className="m-0 mt-4 text-xs text-[var(--sea-ink-soft)]">
          Cross-outlet revenue reporting arrives in Phase 4 with explicit
          data-freshness indicators (PRD §10, §18).
        </p>
      </section>
    </main>
  )
}
