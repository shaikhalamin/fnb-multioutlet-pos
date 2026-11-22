import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { hasPermission } from '#/lib/permissions'
import { logout } from '#/features/auth/api'
import { useSession } from '#/features/auth/session'
import { defaultReportSearch } from '#/routes/_auth/reports'

export default function Header() {
  const session = useSession()
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  const user = session.user
  // The signed-out CTA leads to /login; don't link the sign-in page to itself.
  const onLoginPage = Boolean(matchRoute({ to: '/login' }))

  async function handleLogout() {
    await logout()
    await navigate({ to: '/login', replace: true })
  }

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-canvas px-4">
      <nav className="page-wrap flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
        <h2 className="m-0 flex-shrink-0">
          <Link
            to="/"
            className="font-display text-title-md text-ink no-underline"
          >
            F&amp;B HQ
          </Link>
        </h2>

        <div className="order-3 flex w-full flex-wrap items-center gap-x-5 gap-y-1 pb-1 sm:order-none sm:w-auto sm:flex-nowrap sm:pb-0">
          {user ? (
            <>
              <Link
                to="/dashboard"
                className="nav-link"
                activeProps={{ className: 'nav-link is-active' }}
              >
                Dashboard
              </Link>
              {hasPermission(user, 'menu.read') ? (
                <Link
                  to="/menu"
                  className="nav-link"
                  activeProps={{ className: 'nav-link is-active' }}
                >
                  Menu
                </Link>
              ) : null}
              {hasPermission(user, 'outlets.read') ? (
                <Link
                  to="/outlets"
                  className="nav-link"
                  activeProps={{ className: 'nav-link is-active' }}
                >
                  Outlets
                </Link>
              ) : null}
              {hasPermission(user, 'reports.read') ? (
                <Link
                  to="/reports"
                  search={{ ...defaultReportSearch(), tab: 'revenue' }}
                  className="nav-link"
                  activeProps={{ className: 'nav-link is-active' }}
                >
                  Reports
                </Link>
              ) : null}
              {hasPermission(user, 'audit.read') ? (
                <Link
                  to="/audit"
                  className="nav-link"
                  activeProps={{ className: 'nav-link is-active' }}
                >
                  Audit
                </Link>
              ) : null}
              {hasPermission(user, 'users.read') ? (
                <Link
                  to="/users"
                  className="nav-link"
                  activeProps={{ className: 'nav-link is-active' }}
                >
                  Users
                </Link>
              ) : null}
            </>
          ) : (
            <Link
              to="/"
              className="nav-link"
              activeProps={{ className: 'nav-link is-active' }}
            >
              Home
            </Link>
          )}
          <a
            href="/api/v1/docs"
            className="nav-link"
            target="_blank"
            rel="noreferrer"
          >
            API Docs
          </a>
        </div>

        {user ? (
          <div className="ml-auto flex items-center gap-3">
            <span
              className="hidden text-caption text-muted-foreground sm:inline"
              title={user.permissions.join(', ')}
            >
              {user.email} · {user.roleCodes.join(', ')}
            </span>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="btn-outline btn-sm"
            >
              Sign out
            </button>
          </div>
        ) : onLoginPage ? null : (
          <div className="ml-auto flex items-center gap-3">
            <Link to="/login" className="btn-outline btn-sm no-underline">
              Sign in
            </Link>
          </div>
        )}
      </nav>
    </header>
  )
}
