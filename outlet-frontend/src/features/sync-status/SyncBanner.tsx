import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { extendGrace, fetchSyncStatus, replayQuarantinedEvent } from './api'
import { syncKeys } from './keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { extendGraceFormSchema } from '#/schemas/sync'
import { Button } from '#/components/ui/button'
import { ApiError } from '#/api/axios'

/**
 * Local sync banner (PRD §11, §8.8): menu revision + last sync, pending
 * upload count, escalating warning as the offline grace window approaches
 * expiry, the active emergency override (reason/actor), and manager-only
 * controls — extend-grace dialog + quarantined-event replay (§8.5). Purely
 * informational for sales: the backend enforces the grace policy
 * authoritatively. Hidden for roles without `sync.read` (e.g. cashiers)
 * instead of polling a route that would 403 them every 30s.
 */
export function SyncBanner() {
  const session = useSession()
  const canReadSync = hasPermission(session.user, 'sync.read')
  const canOverride = hasPermission(session.user, 'sync.override')
  const status = useQuery({
    queryKey: syncKeys.status(),
    queryFn: fetchSyncStatus,
    refetchInterval: 30_000,
    enabled: canReadSync,
  })

  const [panel, setPanel] = useState<'none' | 'grace' | 'replay'>('none')

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

  const override = data.grace.override

  return (
    <div role="status" className={`border-b border-hairline ${tone}`}>
      <div className="px-4 py-1.5 text-center text-xs font-medium">
        <span>
          Outlet {data.outletCode} · menu rev{' '}
          <span className="money">{data.lastAppliedRevision}</span> · synced{' '}
          {synced}
        </span>
        {data.outbox.pendingCount > 0 || data.outbox.quarantinedCount > 0 ? (
          <span>
            {' · '}
            <span className="money">{data.outbox.pendingCount}</span> pending
            upload
            {data.outbox.quarantinedCount > 0 ? (
              <>
                {' · '}
                <span className="money">
                  {data.outbox.quarantinedCount}
                </span>{' '}
                quarantined
              </>
            ) : null}
          </span>
        ) : null}
        {override ? (
          <span>
            {' '}
            · override until {new Date(
              override.until,
            ).toLocaleTimeString()} by{' '}
            {override.overriddenBy || 'unknown operator'} — “
            {override.reason || 'no reason recorded'}”
          </span>
        ) : null}
        {data.grace.expired && !override ? (
          <span> · OFFLINE GRACE EXPIRED — sales are blocked until sync</span>
        ) : hoursLeft < data.grace.hours * 0.2 && !override ? (
          <span> · grace ends {expiresAt?.toLocaleTimeString()}</span>
        ) : null}
        <span className="hidden sm:inline">
          {' · '}
          <Link to="/sales" className="underline decoration-dotted">
            history
          </Link>
        </span>
        {canOverride ? (
          <span className="ml-2 inline-flex gap-2 align-middle">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setPanel(panel === 'grace' ? 'none' : 'grace')}
            >
              Extend grace…
            </Button>
            {data.outbox.quarantinedCount > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setPanel(panel === 'replay' ? 'none' : 'replay')}
              >
                Quarantined ({data.outbox.quarantinedCount})
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {panel === 'grace' ? (
        <GracePanel onDone={() => setPanel('none')} />
      ) : null}
      {panel === 'replay' ? (
        <ReplayPanel
          samples={data.outbox.lastErrorSample ?? []}
          onDone={() => setPanel('none')}
        />
      ) : null}
    </div>
  )
}

/** Manager-only: audited emergency extension of the offline grace (§8.8). */
function GracePanel({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [hours, setHours] = useState('24')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const extend = useMutation({
    mutationFn: extendGrace,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: syncKeys.status() })
      onDone()
    },
  })

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = extendGraceFormSchema.safeParse({ hours, reason })
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    setFormError(null)
    extend.mutate(parsed.data)
  }

  const failure = extend.error
  const message =
    failure instanceof ApiError
      ? `${failure.code}: ${failure.message}`
      : failure instanceof Error
        ? failure.message
        : null

  return (
    <form
      onSubmit={submit}
      className="border-t border-hairline bg-surface px-4 py-3 text-left text-body-strong"
    >
      <p className="mb-2 text-xs font-display text-lg">
        Emergency grace override
      </p>
      <p className="mb-3 text-xs text-body">
        Privileged and audited (PRD §8.8): extends the offline sale window from
        now, independent of the last sync. Use for a known outage with a
        recovery plan.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium" htmlFor="grace-hours">
          Hours (1–72)
          <input
            id="grace-hours"
            type="number"
            min={1}
            max={72}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            className="mt-1 block w-24 rounded-lg border border-hairline-strong bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <label
          className="min-w-64 flex-1 text-xs font-medium"
          htmlFor="grace-reason"
        >
          Reason (audited)
          <textarea
            id="grace-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Regional network outage; connector replacement scheduled."
            className="mt-1 block w-full resize-none rounded-lg border border-hairline-strong bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <Button type="submit" disabled={extend.isPending}>
          {extend.isPending ? 'Applying…' : 'Apply override'}
        </Button>
      </div>
      {formError ? (
        <p className="mt-2 text-xs text-error">{formError}</p>
      ) : null}
      {message ? <p className="mt-2 text-xs text-error">{message}</p> : null}
    </form>
  )
}

/** Manager-only: review + replay quarantined events (manual repair, §8.5). */
function ReplayPanel({
  samples,
  onDone,
}: {
  samples: Array<{
    eventId: string
    sequenceNo: string
    lastError: string | null
  }>
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [replayed, setReplayed] = useState<{ sequenceNo: string } | null>(null)

  const replay = useMutation({
    mutationFn: replayQuarantinedEvent,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: syncKeys.status() })
    },
  })

  const message =
    replay.error instanceof ApiError
      ? `${replay.error.code}: ${replay.error.message}`
      : null

  return (
    <div className="border-t border-hairline bg-surface px-4 py-3 text-left text-body-strong">
      <p className="mb-2 font-display text-lg">Quarantined events</p>
      <p className="mb-3 text-xs text-body">
        Terminal delivery failures parked for manual repair — never deleted.
        Review the error, fix the cause, then re-arm for delivery.
      </p>
      {samples.length === 0 ? (
        <p className="text-xs text-body">No quarantined events right now.</p>
      ) : (
        <ul className="space-y-1">
          {samples.map((sample) => (
            <li
              key={sample.eventId}
              className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-1.5 text-xs"
            >
              <span>
                <span className="font-medium">
                  seq <span className="money">{sample.sequenceNo}</span>
                </span>
                {' · '}
                <code className="text-error">
                  {sample.lastError ?? 'UNKNOWN'}
                </code>
              </span>
              {confirming === sample.eventId ? (
                <span className="flex items-center gap-2">
                  <span>Re-arm this event?</span>
                  <Button
                    type="button"
                    size="xs"
                    disabled={replay.isPending}
                    onClick={() => {
                      replay.mutate(sample.eventId, {
                        onSuccess: () =>
                          setReplayed({ sequenceNo: sample.sequenceNo }),
                      })
                      setConfirming(null)
                    }}
                  >
                    Confirm replay
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => setConfirming(sample.eventId)}
                >
                  Replay
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message ? <p className="mt-2 text-xs text-error">{message}</p> : null}
      {replayed ? (
        <p className="mt-2 text-xs text-success">
          Event seq <span className="money">{replayed.sequenceNo}</span>{' '}
          re-armed for delivery.
        </p>
      ) : null}
      <div className="mt-3">
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  )
}
