import { createFileRoute, Outlet, Navigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { refreshSessionNow } from '#/features/auth/api'
import { useSession } from '#/features/auth/session'

/**
 * Protected layout (PRD §11): every POS page sits behind it. Client-side
 * gating is UX only — the backend enforces authorization on every request
 * (AGENTS.md §4.2). On load it tries one silent refresh via the HttpOnly
 * cookie before deciding.
 */
export const Route = createFileRoute('/_auth')({ component: AuthLayout })

function AuthLayout() {
  const session = useSession()
  const [bootstrapped, setBootstrapped] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!session.user) {
      void refreshSessionNow().finally(() => {
        if (!cancelled) setBootstrapped(true)
      })
    } else {
      setBootstrapped(true)
    }
    return () => {
      cancelled = true
    }
  }, [session.user])

  if (session.user) return <Outlet />
  if (!bootstrapped) {
    return (
      <main
        className="page-wrap py-24 text-center text-sm text-[var(--sea-ink-soft)]"
        aria-busy="true"
      >
        Restoring your session…
      </main>
    )
  }
  return <Navigate to="/login" replace />
}
