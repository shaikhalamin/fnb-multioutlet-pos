import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { fetchSyncStatus } from './api'
import { syncKeys } from './keys'

/**
 * Local sync banner (PRD §11, §8.8): menu revision + last sync, pending
 * upload count, and an escalating warning as the offline grace window
 * approaches expiry. Purely informational — it NEVER blocks a local sale
 * (the backend enforces the grace policy authoritatively).
 */
export function SyncBanner() {
  const status = useQuery({
    queryKey: syncKeys.status(),
    queryFn: fetchSyncStatus,
    refetchInterval: 30_000,
  })

  if (status.isPending) return null

  if (status.isError) {
    return (
      <div
        role="status"
        className="border-b border-[var(--line)] bg-[rgba(120,120,120,0.08)] px-4 py-1.5 text-center text-xs text-[var(--sea-ink-soft)]"
      >
        Sync status unavailable (local sales keep working).
      </div>
    )
  }

  const data = status.data
  const synced = data.lastMenuSyncAt
    ? new Date(data.lastMenuSyncAt).toLocaleString()
    : 'never'

  // Escalation: expired ⇒ red and loud; within 20% of the window ⇒ amber.
  const expiresAt = data.grace.expiresAt ? new Date(data.grace.expiresAt) : null
  const hoursLeft = expiresAt
    ? (expiresAt.getTime() - Date.now()) / 3_600_000
    : Number.NEGATIVE_INFINITY
  const tone = data.grace.expired
    ? 'bg-[rgba(235,87,87,0.14)] text-[#a03030]'
    : hoursLeft < data.grace.hours * 0.2
      ? 'bg-[rgba(240,173,20,0.16)] text-[#8a6116]'
      : 'bg-[rgba(86,198,190,0.12)] text-[#2f8f83]'

  return (
    <div
      role="status"
      className={`border-b border-[var(--line)] px-4 py-1.5 text-center text-xs font-semibold ${tone}`}
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
