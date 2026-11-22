import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { apiKeysControllerIssue } from '#/api/generated/clients/apiKeysControllerIssue'
import { apiKeysControllerList } from '#/api/generated/clients/apiKeysControllerList'
import { apiKeysControllerRevoke } from '#/api/generated/clients/apiKeysControllerRevoke'
import { apiKeysControllerRotate } from '#/api/generated/clients/apiKeysControllerRotate'
import { assignmentsControllerListOutletMenu } from '#/api/generated/clients/assignmentsControllerListOutletMenu'
import { assignmentsControllerUnassign } from '#/api/generated/clients/assignmentsControllerUnassign'
import { outletsControllerListOutlets } from '#/api/generated/clients/outletsControllerListOutlets'
import { assignmentsControllerListOutletMenuStatus200Schema } from '#/api/generated/schemas/assignmentsControllerListOutletMenuSchema'
import { useSession } from '#/features/auth/session'
import { AssignToOutletDialog } from '#/features/assignments/AssignToOutletDialog'
import type { AssignSession } from '#/features/assignments/AssignToOutletDialog'
import { useMenuItems } from '#/features/menu/queries'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'
import { outletKeys } from '#/features/outlets/keys'
import { CopyValue } from '#/components/CopyValue'
import { Checkbox } from '#/components/ui/checkbox'
import { cn } from 'cn'

/** In-page section tabs carried in the URL, so a tab is linkable/shareable. */
const outletTabSchema = z.object({
  tab: z.enum(['assignments', 'settings']).catch('assignments'),
})

export const Route = createFileRoute('/_auth/outlets/$outletId')({
  validateSearch: outletTabSchema.parse,
  component: OutletDetailPage,
})

type IssuedKey = { keyId: string; secret: string }

function OutletDetailPage() {
  const { outletId } = Route.useParams()
  const { tab } = Route.useSearch()
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
    // The matrix data only feeds the Assignments tab — don't fetch it when
    // the operator lands straight on Settings (e.g. from the pairing panel).
    enabled: Boolean(outlet) && tab === 'assignments',
  })
  const items = useMenuItems()

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
      <p className="kicker mb-2">
        {outlet ? `Outlet ${outlet.code}` : 'Outlet'}
      </p>
      <h1 className="mb-1 font-display text-display-md text-ink">
        {outlet?.name ?? 'Loading…'}
      </h1>
      {outlet ? (
        <p className="mb-6 mt-1 text-sm text-body">
          {outlet.timezone} · {outlet.status} · catalog revision{' '}
          <span className="money">{outlet.catalogRevision}</span>
        </p>
      ) : null}

      <nav
        aria-label="Outlet sections"
        className="mb-6 flex flex-wrap gap-x-6 gap-y-2 border-b border-hairline pb-3"
      >
        <Link
          to="/outlets/$outletId"
          params={{ outletId }}
          search={{ tab: 'assignments' }}
          aria-current={tab === 'assignments' ? 'page' : undefined}
          className={cn('nav-link', tab === 'assignments' && 'is-active')}
        >
          Menu assignments
        </Link>
        <Link
          to="/outlets/$outletId"
          params={{ outletId }}
          search={{ tab: 'settings' }}
          aria-current={tab === 'settings' ? 'page' : undefined}
          className={cn('nav-link', tab === 'settings' && 'is-active')}
        >
          Settings
        </Link>
      </nav>

      {tab === 'assignments' ? (
        <AssignmentMatrix
          outletId={outletId}
          outletName={outlet?.name ?? null}
          rows={rows}
          canAssign={canAssign}
          onChanged={invalidate}
        />
      ) : (
        <>
          <section className="card-panel mb-6 p-6">
            <h2 className="m-0 mb-1 font-display text-title-md text-ink">
              Outlet identity
            </h2>
            <p className="m-0 mb-4 text-xs text-body">
              The terminal&apos;s{' '}
              <span className="font-medium text-ink">/setup</span> wizard pairs
              to this outlet with the Outlet ID below, together with the outlet
              code shown above the tabs.
            </p>
            {outlet ? (
              <CopyValue
                label="Outlet ID"
                value={outlet.id}
                buttonLabel="Copy Outlet ID"
              />
            ) : (
              <p className="m-0 text-sm text-body" aria-busy="true">
                Loading outlet…
              </p>
            )}
          </section>
          {canManageKeys ? <OutletKeysPanel outletId={outletId} /> : null}
        </>
      )}
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
  outletName,
  rows,
  canAssign,
  onChanged,
}: {
  outletId: string
  outletName: string | null
  rows: MatrixRow[]
  canAssign: boolean
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  // Tick-to-assign: the ticked item ids, and the dialog session they open into
  // (`id` remounts the dialog per session so each one starts from its own state).
  const selectAllRef = useRef<HTMLButtonElement>(null)
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [assignSession, setAssignSession] = useState<
    (AssignSession & { id: number }) | null
  >(null)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const rowIds = rows.map((row) => row.item.id)
  const allRowsSelected =
    rowIds.length > 0 && rowIds.every((id) => selectedSet.has(id))
  const someRowsSelected = rowIds.some((id) => selectedSet.has(id))

  function openAssign(itemIds: readonly string[]) {
    setAssignSession({
      id: (assignSession?.id ?? 0) + 1,
      menuItemIds: [...itemIds],
      outletId,
    })
  }
  // The first tick opens the dialog right away; later ticks only join the
  // selection, and the bar's single button sends them all together.
  function toggleItem(itemId: string, checked: boolean) {
    const next = checked
      ? [...selectedIds, itemId]
      : selectedIds.filter((id) => id !== itemId)
    setSelectedIds(next)
    if (checked && selectedIds.length === 0) openAssign(next)
  }
  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? rowIds : [])
    if (checked && selectedIds.length === 0) openAssign(rowIds)
  }

  // Unassignment is the real DELETE endpoint (soft-unassign + REMOVE catalog
  // revision server-side) — not a `PUT active:false` half-state.
  const unassign = useMutation({
    mutationFn: (itemId: string) =>
      assignmentsControllerUnassign({ path: { outletId, itemId } }),
    onSuccess: () => {
      setError(null)
      onChanged()
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Unassignment failed.',
      ),
  })

  return (
    <section className="card-panel mb-6 p-6">
      <h2 className="m-0 mb-1 font-display text-title-md text-ink">
        Assignment matrix
      </h2>
      <p className="m-0 mb-4 text-xs text-body">
        Tick items to assign them with their price — one submit commits
        atomically. Effective price = override ?? master default (PRD FR-02);
        removing emits a per-outlet catalog revision.
      </p>

      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </p>
      ) : null}

      {canAssign ? (
        <>
          {/* Always rendered so ticking a row never shifts the table (CLS). */}
          <div
            role="region"
            aria-label="Bulk assignment"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-canvas-soft px-4 py-2"
          >
            <p
              role="status"
              aria-atomic="true"
              className="m-0 text-sm text-body"
            >
              {selectedIds.length === 0
                ? 'Tick items to assign them to this outlet.'
                : `${selectedIds.length} ${selectedIds.length === 1 ? 'item' : 'items'} selected`}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedIds([])}
                disabled={selectedIds.length === 0}
                className="btn-outline btn-sm"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => openAssign(selectedIds)}
                disabled={selectedIds.length === 0}
                className="btn-primary btn-sm"
              >
                Assign to {outletName ?? 'outlet'}
              </button>
            </div>
          </div>
          {assignSession ? (
            <AssignToOutletDialog
              key={assignSession.id}
              session={assignSession}
              onSelectionChange={setSelectedIds}
              onClosed={() => setAssignSession(null)}
              fallbackFocusRef={selectAllRef}
            />
          ) : null}
        </>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              {canAssign ? (
                // 36px control + 4px padding: fits the existing row height,
                // so adding the column does not stretch the table.
                <th scope="col" className="py-0.5 pr-2">
                  <Checkbox
                    ref={selectAllRef}
                    aria-label="Select every item"
                    checked={
                      allRowsSelected
                        ? true
                        : someRowsSelected
                          ? 'indeterminate'
                          : false
                    }
                    disabled={rowIds.length === 0}
                    onCheckedChange={(next) => toggleAll(next === true)}
                  />
                </th>
              ) : null}
              <th className="kicker py-2 pr-4">Item</th>
              <th className="kicker py-2 pr-4">Default</th>
              <th className="kicker py-2 pr-4">Effective</th>
              <th className="kicker py-2">Assigned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, active, priceOverrideMinor }) => {
              const selected = selectedSet.has(item.id)
              const effective = priceOverrideMinor ?? item.defaultPriceMinor
              return (
                <tr
                  key={item.id}
                  className={cn(
                    'border-b border-hairline-soft transition-colors',
                    selected && 'bg-surface-strong',
                  )}
                >
                  {canAssign ? (
                    <td className="py-0.5 pr-2">
                      <Checkbox
                        aria-label={`Select ${item.name}`}
                        checked={selected}
                        onCheckedChange={(next) =>
                          toggleItem(item.id, next === true)
                        }
                      />
                    </td>
                  ) : null}
                  <td className="py-2 pr-4">
                    <p className="m-0 font-medium text-ink">{item.name}</p>
                    <p className="m-0 text-xs text-body">
                      {item.sku} · {item.categoryName}
                    </p>
                  </td>
                  <td className="money py-2 pr-4">
                    {formatMinor(item.defaultPriceMinor, item.currencyCode)}
                  </td>
                  <td
                    className="money py-2 pr-4 font-medium text-ink"
                    title={
                      priceOverrideMinor !== null
                        ? `Outlet override ${formatMinor(priceOverrideMinor, item.currencyCode)}`
                        : 'Master default price'
                    }
                  >
                    {formatMinor(effective, item.currencyCode)}
                  </td>
                  <td className="py-2">
                    {active ? (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="badge-pill badge-success">
                          Assigned
                        </span>
                        {canAssign ? (
                          <button
                            type="button"
                            disabled={unassign.isPending}
                            onClick={() => unassign.mutate(item.id)}
                            className="btn-outline btn-sm text-error"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    ) : canAssign ? null : (
                      <span className="text-xs text-body">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 mt-4 text-sm text-body">
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

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: outletKeys.keys(outletId) })

  const issue = useMutation({
    mutationFn: () => apiKeysControllerIssue({ path: { outletId }, body: {} }),
    onSuccess: (result) => {
      // The raw secret exists only in this one-time view (PRD §9.2).
      setIssued({ keyId: result.keyId, secret: result.secret })
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
      invalidate()
    },
  })
  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      apiKeysControllerRevoke({ path: { outletId, keyId } }),
    onSuccess: invalidate,
  })

  return (
    <section className="card-panel p-6">
      <h2 className="m-0 mb-1 font-display text-title-md text-ink">
        Outlet sync keys
      </h2>
      <p className="m-0 mb-4 text-xs text-body">
        Pairs the outlet terminal for sync — its setup wizard asks for the{' '}
        <span className="font-medium text-ink">key ID</span> and the{' '}
        <span className="font-medium text-ink">secret</span> as two separate
        values. The secret is revealed exactly once at issue/rotation.
      </p>

      {issued ? (
        <div
          className="mb-4 rounded-xl border border-hairline bg-canvas-soft p-4"
          role="alert"
        >
          <p className="kicker m-0 mb-1">
            One-time secret — store it now, it will not be shown again
          </p>
          <p className="m-0 mb-3 text-xs text-body">
            The terminal&apos;s setup wizard asks for the{' '}
            <span className="font-medium text-ink">key ID</span> and the{' '}
            <span className="font-medium text-ink">secret</span> as two separate
            values — copy each row into its own field there.
          </p>
          <div className="flex flex-col gap-3">
            <CopyValue
              label="Key ID"
              value={issued.keyId}
              buttonLabel="Copy key ID"
            />
            <CopyValue
              label="Key secret (shown once)"
              value={issued.secret}
              buttonLabel="Copy secret"
            />
          </div>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="btn-outline btn-sm mt-3"
          >
            Dismiss — I stored it
          </button>
        </div>
      ) : null}

      {keys.isPending ? (
        <p className="m-0 text-sm text-body" aria-busy="true">
          Loading keys…
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left">
              <th className="kicker py-2 pr-4">Key ID</th>
              <th className="kicker py-2 pr-4">Status</th>
              <th className="kicker py-2 pr-4">Expires</th>
              <th className="kicker py-2 pr-4">Last used</th>
              <th className="kicker py-2 pr-4">Rotated from</th>
              <th className="kicker py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.data?.map((key) => (
              <tr key={key.id} className="border-b border-hairline-soft">
                <td className="money py-2 pr-4 text-xs">{key.keyId}</td>
                <td className="py-2 pr-4">{key.status}</td>
                <td className="py-2 pr-4 text-xs text-body">
                  {key.expiresAt
                    ? new Date(key.expiresAt).toLocaleString()
                    : '—'}
                </td>
                <td className="py-2 pr-4 text-xs text-body">
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toLocaleString()
                    : 'never'}
                </td>
                <td className="money py-2 pr-4 text-xs text-body">
                  {key.rotatedFromKeyId ?? '—'}
                </td>
                <td className="py-2">
                  <div className="flex gap-2 text-xs">
                    {key.status === 'ACTIVE' ? (
                      <>
                        <button
                          type="button"
                          className="font-medium text-ink hover:underline"
                          onClick={() => rotate.mutate(key.keyId)}
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          className="font-medium text-error hover:underline"
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
        className="btn-primary btn-sm mt-4"
      >
        Issue new key
      </button>
    </section>
  )
}
