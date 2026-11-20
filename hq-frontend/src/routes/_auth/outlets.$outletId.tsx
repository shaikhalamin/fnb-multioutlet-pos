import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ApiError } from '#/api/axios'
import { apiKeysControllerIssue } from '#/api/generated/clients/apiKeysControllerIssue'
import { apiKeysControllerList } from '#/api/generated/clients/apiKeysControllerList'
import { apiKeysControllerRevoke } from '#/api/generated/clients/apiKeysControllerRevoke'
import { apiKeysControllerRotate } from '#/api/generated/clients/apiKeysControllerRotate'
import { assignmentsControllerAssign } from '#/api/generated/clients/assignmentsControllerAssign'
import { assignmentsControllerListOutletMenu } from '#/api/generated/clients/assignmentsControllerListOutletMenu'
import { assignmentsControllerUnassign } from '#/api/generated/clients/assignmentsControllerUnassign'
import { menuControllerListItems } from '#/api/generated/clients/menuControllerListItems'
import { outletsControllerListOutlets } from '#/api/generated/clients/outletsControllerListOutlets'
import { assignmentsControllerListOutletMenuStatus200Schema } from '#/api/generated/schemas/assignmentsControllerListOutletMenuSchema'
import { menuControllerListItemsStatus200Schema } from '#/api/generated/schemas/menuControllerListItemsSchema'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'
import { outletKeys } from '#/features/outlets/keys'

export const Route = createFileRoute('/_auth/outlets/$outletId')({
  component: OutletDetailPage,
})

type IssuedKey = { keyId: string; secret: string }

function OutletDetailPage() {
  const { outletId } = Route.useParams()
  const session = useSession()
  const queryClient = useQueryClient()
  const canAssign = hasPermission(session.user, 'assignments.write')
  const canManageKeys = hasPermission(session.user, 'keys.manage')

  const outlets = useQuery({
    queryKey: outletKeys.list(),
    queryFn: () => outletsControllerListOutlets(),
  })
  const outlet = outlets.data?.find((entry) => entry.id === outletId)

  const outletMenu = useQuery({
    queryKey: outletKeys.menu(outletId),
    // Money-bearing payload: parse with the generated Zod schema before use
    // (AGENTS §4.2).
    queryFn: async () =>
      assignmentsControllerListOutletMenuStatus200Schema.parse(
        await assignmentsControllerListOutletMenu({ path: { outletId } }),
      ),
    enabled: Boolean(outlet),
  })
  const items = useQuery({
    queryKey: ['menu', 'items', 'matrix'],
    // Money-bearing payload (defaultPriceMinor): parse with the generated
    // Zod schema before use (AGENTS §4.2).
    queryFn: async () =>
      menuControllerListItemsStatus200Schema.parse(
        await menuControllerListItems({ query: { limit: 200 } }),
      ),
    enabled: Boolean(outlet),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: outletKeys.menu(outletId) })
    void queryClient.invalidateQueries({ queryKey: outletKeys.list() })
  }

  /** Matrix rows: every ACTIVE master item joined with its assignment state. */
  const rows = useMemo(() => {
    const byItem = new Map(
      (outletMenu.data ?? []).map((row) => [row.menuItemId, row]),
    )
    return (items.data ?? [])
      .filter((item) => item.status === 'ACTIVE')
      .map((item) => {
        const assignment = byItem.get(item.id)
        return {
          item,
          assignmentId: assignment?.assignmentId ?? null,
          active: assignment?.active ?? false,
          priceOverrideMinor: assignment?.priceOverrideMinor ?? null,
        }
      })
  }, [outletMenu.data, items.data])

  return (
    <main className="page-wrap py-10">
      <p className="island-kicker mb-2">
        {outlet ? `Outlet ${outlet.code}` : 'Outlet'}
      </p>
      <h1 className="mb-1 text-2xl font-semibold text-[var(--sea-ink)]">
        {outlet?.name ?? 'Loading…'}
      </h1>
      {outlet ? (
        <p className="mb-6 mt-1 text-sm text-[var(--sea-ink-soft)]">
          {outlet.timezone} · {outlet.status} · catalog revision{' '}
          {outlet.catalogRevision}
        </p>
      ) : null}

      <AssignmentMatrix
        outletId={outletId}
        rows={rows}
        canAssign={canAssign}
        onChanged={invalidate}
      />
      {canManageKeys ? <OutletKeysPanel outletId={outletId} /> : null}
    </main>
  )
}

type MatrixRow = {
  item: {
    id: string
    sku: string
    name: string
    categoryName: string
    defaultPriceMinor: string
    currencyCode: string
  }
  assignmentId: string | null
  active: boolean
  priceOverrideMinor: string | null
}

function AssignmentMatrix({
  outletId,
  rows,
  canAssign,
  onChanged,
}: {
  outletId: string
  rows: MatrixRow[]
  canAssign: boolean
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  // Undefined = untouched (inherit the persisted override), '' = cleared.
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({})
  const [error, setError] = useState<string | null>(null)

  const assign = useMutation({
    mutationFn: (input: {
      itemId: string
      active: boolean
      priceOverrideMinor: string | null
    }) =>
      assignmentsControllerAssign({
        path: { outletId, itemId: input.itemId },
        body: {
          active: input.active,
          priceOverrideMinor: input.priceOverrideMinor,
        },
      }),
    onSuccess: () => {
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({
        queryKey: ['menu', 'items', 'matrix'],
      })
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Assignment failed.',
      ),
  })

  // Unassignment is the real DELETE endpoint (soft-unassign + REMOVE catalog
  // revision server-side) — not a `PUT active:false` half-state.
  const unassign = useMutation({
    mutationFn: (itemId: string) =>
      assignmentsControllerUnassign({ path: { outletId, itemId } }),
    onSuccess: () => {
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({
        queryKey: ['menu', 'items', 'matrix'],
      })
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Unassignment failed.',
      ),
  })

  return (
    <section className="island-shell mb-6 rounded-2xl p-6">
      <h2 className="m-0 mb-1 text-base font-semibold text-[var(--sea-ink)]">
        Assignment matrix
      </h2>
      <p className="m-0 mb-4 text-xs text-[var(--sea-ink-soft)]">
        Effective price = override ?? master default (PRD FR-02). Saving emits a
        per-outlet catalog revision atomically.
      </p>

      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-[rgba(235,87,87,0.12)] px-3 py-2 text-sm text-[#a03030]"
        >
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <th className="py-2 pr-4">Item</th>
              <th className="py-2 pr-4">Default</th>
              <th className="py-2 pr-4">Override (minor)</th>
              <th className="py-2 pr-4">Effective preview</th>
              <th className="py-2">Assigned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, active, priceOverrideMinor }) => {
              const draft: string | undefined = drafts[item.id]
              const overrideDraft =
                draft === undefined
                  ? priceOverrideMinor
                  : draft === ''
                    ? null
                    : draft
              const effective = overrideDraft ?? item.defaultPriceMinor
              return (
                <tr key={item.id} className="border-b border-[var(--line)]/60">
                  <td className="py-2 pr-4">
                    <p className="m-0 font-medium text-[var(--sea-ink)]">
                      {item.name}
                    </p>
                    <p className="m-0 font-mono text-xs text-[var(--sea-ink-soft)]">
                      {item.sku} · {item.categoryName}
                    </p>
                  </td>
                  <td className="py-2 pr-4">
                    {formatMinor(item.defaultPriceMinor, item.currencyCode)}
                  </td>
                  <td className="py-2 pr-4">
                    <input
                      value={
                        draft !== undefined ? draft : (priceOverrideMinor ?? '')
                      }
                      disabled={!canAssign}
                      onChange={(event) =>
                        setDrafts({ ...drafts, [item.id]: event.target.value })
                      }
                      placeholder="inherit"
                      inputMode="numeric"
                      className="w-28 rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-2.5 py-1.5 text-sm disabled:opacity-50"
                    />
                  </td>
                  <td className="py-2 pr-4 font-semibold text-[#2f8f83]">
                    {formatMinor(effective, item.currencyCode)}
                  </td>
                  <td className="py-2">
                    {canAssign ? (
                      <div className="flex flex-wrap gap-2 text-xs">
                        <button
                          type="button"
                          disabled={assign.isPending || unassign.isPending}
                          onClick={() => {
                            // Client-side guard is UX only (AGENTS §4.2): the
                            // backend re-validates the minor-units pattern.
                            if (
                              draft !== undefined &&
                              draft !== '' &&
                              !/^(0|[1-9][0-9]*)$/.test(draft)
                            ) {
                              setError(
                                'Override must be integer minor units (e.g. 1200 = $12.00).',
                              )
                              return
                            }
                            assign.mutate({
                              itemId: item.id,
                              active: true,
                              priceOverrideMinor:
                                draft === undefined
                                  ? (priceOverrideMinor ?? null)
                                  : draft === ''
                                    ? null
                                    : draft,
                            })
                          }}
                          className={
                            active
                              ? 'rounded-full bg-[rgba(52,199,89,0.16)] px-3 py-1 font-semibold text-[#1d7a3f]'
                              : 'rounded-full border border-[var(--chip-line)] px-3 py-1 font-semibold text-[var(--sea-ink)]'
                          }
                        >
                          {active ? 'Assigned' : 'Assign'}
                        </button>
                        {active ? (
                          <button
                            type="button"
                            disabled={assign.isPending || unassign.isPending}
                            onClick={() => unassign.mutate(item.id)}
                            className="rounded-full border border-[var(--chip-line)] px-3 py-1 font-semibold text-[#a03030]"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--sea-ink-soft)]">
                        {active ? 'Assigned' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 mt-4 text-sm text-[var(--sea-ink-soft)]">
          No active master items yet — create some on the Menu page first.
        </p>
      ) : null}
    </section>
  )
}

function OutletKeysPanel({ outletId }: { outletId: string }) {
  const queryClient = useQueryClient()
  const keys = useQuery({
    queryKey: outletKeys.keys(outletId),
    queryFn: () => apiKeysControllerList({ path: { outletId } }),
  })
  const [issued, setIssued] = useState<IssuedKey | null>(null)
  const [copied, setCopied] = useState(false)

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: outletKeys.keys(outletId) })

  const issue = useMutation({
    mutationFn: () => apiKeysControllerIssue({ path: { outletId }, body: {} }),
    onSuccess: (result) => {
      // The raw secret exists only in this one-time view (PRD §9.2).
      setIssued({ keyId: result.keyId, secret: result.secret })
      setCopied(false)
      invalidate()
    },
  })
  const rotate = useMutation({
    mutationFn: (keyId: string) =>
      apiKeysControllerRotate({
        path: { outletId, keyId },
        body: { graceHours: 24 },
      }),
    onSuccess: (result) => {
      setIssued({ keyId: result.keyId, secret: result.secret })
      setCopied(false)
      invalidate()
    },
  })
  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      apiKeysControllerRevoke({ path: { outletId, keyId } }),
    onSuccess: invalidate,
  })

  async function copySecret(): Promise<void> {
    if (!issued) return
    await navigator.clipboard.writeText(`${issued.keyId}.${issued.secret}`)
    setCopied(true)
  }

  return (
    <section className="island-shell rounded-2xl p-6">
      <h2 className="m-0 mb-1 text-base font-semibold text-[var(--sea-ink)]">
        Outlet sync keys
      </h2>
      <p className="m-0 mb-4 text-xs text-[var(--sea-ink-soft)]">
        Used by the outlet worker as{' '}
        <code>Authorization: OutletKey keyId.secret</code>. The secret is
        revealed exactly once at issue/rotation.
      </p>

      {issued ? (
        <div
          className="mb-4 rounded-xl border border-[#56c6be] bg-[rgba(86,198,190,0.08)] p-4"
          role="alert"
        >
          <p className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-[#2f8f83]">
            One-time secret — store it now, it will not be shown again
          </p>
          <code className="block break-all rounded-lg bg-[var(--card,#fff)] px-3 py-2 text-xs">
            {issued.keyId}.{issued.secret}
          </code>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copySecret()}
              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-4 py-1.5 text-xs font-semibold text-white"
            >
              {copied ? 'Copied ✓' : 'Copy full key'}
            </button>
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="rounded-full border border-[var(--chip-line)] px-4 py-1.5 text-xs font-semibold text-[var(--sea-ink)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {keys.isPending ? (
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]" aria-busy="true">
          Loading keys…
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
              <th className="py-2 pr-4">Key ID</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Expires</th>
              <th className="py-2 pr-4">Last used</th>
              <th className="py-2 pr-4">Rotated from</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.data?.map((key) => (
              <tr key={key.id} className="border-b border-[var(--line)]/60">
                <td className="py-2 pr-4 font-mono text-xs">{key.keyId}</td>
                <td className="py-2 pr-4">{key.status}</td>
                <td className="py-2 pr-4 text-xs text-[var(--sea-ink-soft)]">
                  {key.expiresAt
                    ? new Date(key.expiresAt).toLocaleString()
                    : '—'}
                </td>
                <td className="py-2 pr-4 text-xs text-[var(--sea-ink-soft)]">
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toLocaleString()
                    : 'never'}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-[var(--sea-ink-soft)]">
                  {key.rotatedFromKeyId ?? '—'}
                </td>
                <td className="py-2">
                  <div className="flex gap-2 text-xs">
                    {key.status === 'ACTIVE' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => rotate.mutate(key.keyId)}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          className="text-[#a03030]"
                          onClick={() => revoke.mutate(key.keyId)}
                        >
                          Revoke
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button
        type="button"
        disabled={issue.isPending}
        onClick={() => issue.mutate()}
        className="mt-4 rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
      >
        Issue new key
      </button>
    </section>
  )
}
