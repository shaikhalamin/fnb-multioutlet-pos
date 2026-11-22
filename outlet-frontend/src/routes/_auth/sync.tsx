import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { fetchSyncStatus, updateHqConnection } from '#/features/sync-status/api'
import { syncKeys } from '#/features/sync-status/keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'

export const Route = createFileRoute('/_auth/sync')({ component: SyncPage })

const rotateSchema = z.object({
  hqApiBaseUrl: z
    .string()
    .url('Enter the HQ base URL, e.g. http://hq-api:3000/api/v1.'),
  keyId: z
    .string()
    .min(8, 'Paste the new key ID shown when HQ issued the key.'),
  keySecret: z.string().min(16, 'Paste the one-time key secret from HQ.'),
})

/** Stable backend error codes (PRD §12) → human-friendly rotation messages. */
const ROTATE_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED:
    'HQ rejected this key — check the key ID and one-time secret (a key for another outlet is refused).',
  SYNC_TEMPORARILY_UNAVAILABLE:
    'HQ is unreachable at that URL; the stored key was left unchanged.',
  CONFLICT: 'Terminal not paired yet — pair from the setup wizard first.',
}

/**
 * Local sync detail (PRD §8.8, §11): the full checkpoint/outbox picture plus
 * the HQ connection card — current pairing (key ID only) and the manager-only
 * key rotation form. Sync never depends on HQ being reachable (PRD §2).
 */
function SyncPage() {
  const session = useSession()
  const canManage = hasPermission(session.user, 'sync.manage')
  const status = useQuery({
    queryKey: syncKeys.status(),
    queryFn: fetchSyncStatus,
    refetchInterval: 30_000,
  })

  if (status.isPending) {
    return (
      <main className="page-wrap py-10">
        <p className="m-0 text-sm text-body" aria-busy="true">
          Loading sync status…
        </p>
      </main>
    )
  }

  if (status.isError) {
    const error = status.error instanceof ApiError ? status.error : null
    return (
      <main className="page-wrap py-10">
        <section className="card-panel p-6" role="alert">
          <p className="kicker mb-2">Sync</p>
          <p className="m-0 text-sm text-error">
            {error
              ? `${error.code}: ${error.message}`
              : 'Failed to load sync status.'}
          </p>
        </section>
      </main>
    )
  }

  const data = status.data

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Terminal</p>
      <h1 className="mb-6 font-display text-display-md text-ink">Sync</h1>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card-panel p-6">
          <p className="kicker mb-3">Menu checkpoint</p>
          <dl className="m-0 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="kicker mb-1">Outlet</dt>
              <dd className="m-0 font-medium text-ink">
                {data.outletCode}{' '}
                <span className="text-xs text-muted-foreground">
                  ({data.outletId})
                </span>
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Applied revision</dt>
              <dd className="m-0 font-medium text-ink">
                <span className="money">{data.lastAppliedRevision}</span>
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Last menu sync</dt>
              <dd className="m-0 font-medium text-ink">
                {data.lastMenuSyncAt
                  ? new Date(data.lastMenuSyncAt).toLocaleString()
                  : 'never'}
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Grace window</dt>
              <dd className="m-0 font-medium text-ink">
                {data.grace.hours}h —{' '}
                {data.grace.expired
                  ? 'EXPIRED (sales blocked)'
                  : data.grace.expiresAt
                    ? `until ${new Date(data.grace.expiresAt).toLocaleString()}`
                    : 'unknown'}
              </dd>
            </div>
          </dl>
        </section>

        <section className="card-panel p-6">
          <p className="kicker mb-3">Outbox</p>
          <dl className="m-0 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="kicker mb-1">Pending upload</dt>
              <dd className="m-0 font-medium text-ink">
                <span className="money">{data.outbox.pendingCount}</span>
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Quarantined</dt>
              <dd className="m-0 font-medium text-ink">
                <span className="money">{data.outbox.quarantinedCount}</span>
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Oldest pending</dt>
              <dd className="m-0 font-medium text-ink">
                {data.outbox.oldestPendingAt
                  ? new Date(data.outbox.oldestPendingAt).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="kicker mb-1">Last delivered</dt>
              <dd className="m-0 font-medium text-ink">
                {data.outbox.lastPublishedAt
                  ? new Date(data.outbox.lastPublishedAt).toLocaleString()
                  : 'never'}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="card-panel mt-6 p-6">
        <p className="kicker mb-3">HQ connection</p>
        {data.hqConnection ? (
          canManage ? (
            <HqConnectionCard
              hqApiBaseUrl={data.hqConnection.hqApiBaseUrl}
              keyId={data.hqConnection.keyId}
              lastValidatedAt={data.hqConnection.lastValidatedAt}
            />
          ) : (
            <p className="m-0 text-sm text-body">
              Paired — key{' '}
              <span className="money">{data.hqConnection.keyId}</span> at{' '}
              {data.hqConnection.hqApiBaseUrl}, accepted by HQ at{' '}
              {new Date(data.hqConnection.lastValidatedAt).toLocaleString()}.
            </p>
          )
        ) : (
          <p className="m-0 text-sm text-body">
            Not paired — complete the setup wizard to connect this terminal to
            HQ.
          </p>
        )}
      </section>
    </main>
  )
}

/** Manager-only: current pairing summary + the audited key-rotation form. */
function HqConnectionCard(props: {
  hqApiBaseUrl: string
  keyId: string
  lastValidatedAt: string
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    hqApiBaseUrl: props.hqApiBaseUrl,
    keyId: '',
    keySecret: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [rotatedAt, setRotatedAt] = useState<string | null>(null)

  const rotate = useMutation({
    mutationFn: updateHqConnection,
    onSuccess: (result) => {
      setError(null)
      setRotatedAt(result.lastValidatedAt)
      setForm((current) => ({ ...current, keyId: '', keySecret: '' }))
      void queryClient.invalidateQueries({ queryKey: syncKeys.status() })
    },
    onError: (cause) => {
      setRotatedAt(null)
      if (cause instanceof ApiError) {
        const friendly = ROTATE_ERROR_MESSAGES[cause.code]
        setError(friendly ? friendly : `${cause.code}: ${cause.message}`)
      } else {
        setError('Rotation failed. Please try again.')
      }
    },
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = rotateSchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    rotate.mutate(parsed.data)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-body">
        Paired — key <span className="money">{props.keyId}</span> at{' '}
        {props.hqApiBaseUrl}, accepted by HQ at{' '}
        {new Date(props.lastValidatedAt).toLocaleString()}.
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-ink">
          Rotate the HQ key
        </summary>
        <p className="mt-2 mb-3 text-xs text-body">
          In HQ: this outlet’s page → API keys → Issue key (or Rotate). Paste
          the new one-time pair below — HQ validates it live before this
          terminal switches over. Audited on both sides.
        </p>
        <form
          onSubmit={handleSubmit}
          className="grid gap-3 sm:grid-cols-2"
          noValidate
        >
          <label className="flex flex-col gap-1.5 text-xs font-semibold">
            HQ base URL
            <input
              required
              value={form.hqApiBaseUrl}
              onChange={(event) =>
                setForm({ ...form, hqApiBaseUrl: event.target.value.trim() })
              }
              className="text-input font-normal"
              placeholder="http://hq-api:3000/api/v1"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-semibold">
            New key ID
            <input
              required
              value={form.keyId}
              onChange={(event) =>
                setForm({ ...form, keyId: event.target.value.trim() })
              }
              className="text-input font-normal"
              placeholder="ok_dev_…"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-semibold sm:col-span-2">
            New key secret (shown once by HQ)
            <input
              type="password"
              required
              autoComplete="off"
              value={form.keySecret}
              onChange={(event) =>
                setForm({ ...form, keySecret: event.target.value.trim() })
              }
              className="text-input font-normal"
              placeholder="one-time secret"
            />
          </label>
          <div className="col-span-full flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={rotate.isPending}
              className="btn-primary btn-sm"
            >
              {rotate.isPending ? 'Validating with HQ…' : 'Test & rotate'}
            </button>
            {error ? (
              <p role="alert" className="m-0 text-xs text-error">
                {error}
              </p>
            ) : null}
            {rotatedAt ? (
              <p className="m-0 text-xs text-success">
                Rotated — HQ accepted the new key at{' '}
                {new Date(rotatedAt).toLocaleString()}.
              </p>
            ) : null}
          </div>
        </form>
      </details>
    </div>
  )
}
