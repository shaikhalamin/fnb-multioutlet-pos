import { Link, useNavigate } from '@tanstack/react-router'
import ThemeToggle from './ThemeToggle'
import { hasPermission } from '#/lib/permissions'
import { logout } from '#/features/auth/api'
import { useSession } from '#/features/auth/session'

export default function Header() {
  const session = useSession()
  const navigate = useNavigate()
  const user = session.user

  async function handleLogout() {
    await logout()
    await navigate({ to: '/login', replace: true })
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
      <nav className="page-wrap flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:py-4">
        <h2 className="m-0 flex-shrink-0 text-base font-semibold tracking-tight">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-sm text-[var(--sea-ink)] no-underline shadow-[0_8px_24px_rgba(30,90,72,0.08)] sm:px-4 sm:py-2"
          >
            <span className="h-2 w-2 rounded-full bg-[linear-gradient(90deg,#56c6be,#7ed3bf)]" />
            F&amp;B HQ
          </Link>
        </h2>

        <div className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1 pb-1 text-sm font-semibold sm:order-none sm:w-auto sm:flex-nowrap sm:pb-0">
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

        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <div className="flex items-center gap-2 text-sm">
              <span
                className="hidden text-[var(--sea-ink-soft)] sm:inline"
                title={user.permissions.join(', ')}
              >
                {user.email} · {user.roleCodes.join(', ')}
              </span>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink)] transition hover:brightness-96"
              >
                Sign out
              </button>
            </div>
          ) : null}
          <ThemeToggle />
        </div>
      </nav>
    </header>
  )
}
