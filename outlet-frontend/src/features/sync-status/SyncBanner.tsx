import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { fetchSyncStatus } from './api'
import { syncKeys } from './keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'

/**
 * Local sync banner (PRD §11, §8.8): menu revision + last sync, pending
 * upload count, and an escalating warning as the offline grace window
 * approaches expiry. Purely informational — it NEVER blocks a local sale
 * (the backend enforces the grace policy authoritatively). Hidden for
 * roles without `sync.read` (e.g. cashiers) instead of polling a route
 * that would 403 them every 30s.
 */
export function SyncBanner() {
  const session = useSession()
  const canReadSync = hasPermission(session.user, 'sync.read')
  const status = useQuery({
    queryKey: syncKeys.status(),
    queryFn: fetchSyncStatus,
    refetchInterval: 30_000,
    enabled: canReadSync,
  })

  if (!canReadSync || status.isPending) return null

  if (status.isError) {
    return (
      <div
        role="status"
        className="border-b border-hairline bg-surface-strong px-4 py-1.5 text-center text-xs text-body"
      >
        Sync status unavailable (local sales keep working).
      </div>
    )
  }

  const data = status.data
  const synced = data.lastMenuSyncAt
    ? new Date(data.lastMenuSyncAt).toLocaleString()
    : 'never'

  // Escalation: expired ⇒ error and loud; within 20% of the window ⇒ neutral
  // warning (the system has no amber — neutral stays on-system).
  const expiresAt = data.grace.expiresAt ? new Date(data.grace.expiresAt) : null
  const hoursLeft = expiresAt
    ? (expiresAt.getTime() - Date.now()) / 3_600_000
    : Number.NEGATIVE_INFINITY
  const tone = data.grace.expired
    ? 'bg-error/10 text-error'
    : hoursLeft < data.grace.hours * 0.2
      ? 'bg-surface-strong text-body-strong'
      : 'bg-success/10 text-success'

  return (
    <div
      role="status"
      className={`border-b border-hairline px-4 py-1.5 text-center text-xs font-medium ${tone}`}
    >
      <span>
        Outlet {data.outletCode} · menu rev {data.lastAppliedRevision} · synced{' '}
        {synced}
      </span>
      {data.outbox.pendingCount > 0 || data.outbox.quarantinedCount > 0 ? (
        <span>
          {' · '}
          {data.outbox.pendingCount} pending upload
          {data.outbox.quarantinedCount > 0
            ? ` · ${data.outbox.quarantinedCount} quarantined`
            : ''}
        </span>
      ) : null}
      {data.grace.expired ? (
        <span> · OFFLINE GRACE EXPIRED — sales are blocked until sync</span>
      ) : hoursLeft < data.grace.hours * 0.2 ? (
        <span> · grace ends {expiresAt?.toLocaleTimeString()}</span>
      ) : null}
      <span className="hidden sm:inline">
        {' · '}
        <Link to="/sales" className="underline decoration-dotted">
          history
        </Link>
      </span>
    </div>
  )
}
