import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { cn } from 'cn'
import {
  CircleCheckIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SearchIcon,
} from 'lucide-react'
import { ApiError } from '#/api/axios'
import { assignmentsControllerAssignMany } from '#/api/generated/clients/assignmentsControllerAssignMany'
import { assignmentsControllerListOutletMenu } from '#/api/generated/clients/assignmentsControllerListOutletMenu'
import { assignmentsControllerAssignManyStatus201Schema } from '#/api/generated/schemas/assignmentsControllerAssignManySchema'
import { assignmentsControllerListOutletMenuStatus200Schema } from '#/api/generated/schemas/assignmentsControllerListOutletMenuSchema'
import type { AssignMenuItemLine } from '#/api/generated/types/AssignMenuItemLine'
import type { AssignMenuItemsResponse } from '#/api/generated/types/AssignMenuItemsResponse'
import type { MenuItemResponse } from '#/api/generated/types/MenuItemResponse'
import { toastSuccess } from '#/components/Toaster'
import { Checkbox } from '#/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '#/components/ui/dialog'
import { isAssignable, useMenuItems } from '#/features/menu/queries'
import { outletKeys } from '#/features/outlets/keys'
import { useOutlets } from '#/features/outlets/queries'
import { formatMinor, majorToMinor } from '#/lib/utils'

/**
 * Bulk outlet assignment (PRD FR-02) from the outlet details page: the outlet
 * is already chosen, so the dialog only picks items and their optional prices
 * — leave a price empty to keep the current one. One ink pill then sends ONE
 * `POST /outlets/:outletId/menu`, so every selected item commits together or
 * nothing does — never a fan-out of single PUTs, which would leave a
 * half-assigned outlet behind on a mid-way failure.
 */

/** The choice the details page already made when it opens the dialog. */
export type AssignSession = {
  /** Items ticked on the outlet's assignment table. */
  menuItemIds: string[]
  /** The outlet whose details page opened the dialog. */
  outletId: string
}

type Failure = {
  title: string
  detail: string
  /** Items the operator can drop from the selection before retrying. */
  removableIds: string[]
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`
}

function listNames(names: string[]): string {
  if (names.length === 0) return 'Some items'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

function readIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : []
}

/** Stable-code → actionable message (AGENTS §4.3): what happened + how to recover. */
function describeFailure(cause: unknown, items: MenuItemResponse[]): Failure {
  // A 4xx from this endpoint means the whole request was rejected before commit.
  if (
    cause instanceof ApiError &&
    cause.status !== undefined &&
    cause.status < 500
  ) {
    const rejected = readIds(cause.details?.menuItemIds)
    if (
      rejected.length > 0 &&
      (cause.code === 'ITEM_INACTIVE' || cause.code === 'NOT_FOUND')
    ) {
      const namesById = new Map(items.map((item) => [item.id, item.name]))
      const names = rejected
        .map((id) => namesById.get(id))
        .filter((name): name is string => name !== undefined)
      const state =
        cause.code === 'ITEM_INACTIVE' ? 'archived' : 'no longer available'
      return {
        title:
          cause.code === 'ITEM_INACTIVE'
            ? 'Archived items cannot be assigned.'
            : 'Some items are no longer available.',
        detail: `Nothing was changed. ${listNames(names)} ${names.length === 1 ? 'is' : 'are'} ${state}.`,
        removableIds: rejected,
      }
    }
    if (cause.code === 'FORBIDDEN') {
      return {
        title: 'You cannot assign items to this outlet.',
        detail:
          'Nothing was changed. Ask an HQ administrator for the assignments.write permission.',
        removableIds: [],
      }
    }
    return {
      title: 'Nothing was changed.',
      detail: `${cause.code}: ${cause.message}`,
      removableIds: [],
    }
  }
  // Timeout / network / 5xx: the outcome is unknown, but the endpoint is
  // idempotent (already-assigned items come back UNCHANGED), so a retry is safe.
  return {
    title: 'We could not confirm the result.',
    detail:
      'Check the outlet, then retry if needed. Retrying is safe: items that are already assigned are left as they are.',
    removableIds: [],
  }
}

type Props = {
  session: AssignSession
  /** The dialog finished closing (cancel or done) — the caller unmounts it. */
  onClosed: () => void
  /**
   * The caller's mirrored item selection: sent whenever the selection changes
   * here, and as `[]` once an assignment succeeds and the dialog is dismissed.
   */
  onSelectionChange?: (menuItemIds: string[]) => void
  /**
   * Where focus goes when the opening control can no longer take it — e.g.
   * the header select-all checkbox is disabled again once an assignment
   * finished and cleared the selection.
   */
  fallbackFocusRef?: RefObject<HTMLElement | null>
}

export function AssignToOutletDialog({
  session,
  onClosed,
  onSelectionChange,
  fallbackFocusRef,
}: Props) {
  const queryClient = useQueryClient()
  const baseId = useId()
  const items = useMenuItems()
  const outlets = useOutlets()
  const outletId = session.outletId
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState<readonly string[]>(
    session.menuItemIds,
  )
  /** Per-item override drafts in dollars ("10.50"); absent/empty = keep. */
  const [priceDrafts, setPriceDrafts] = useState<
    Partial<Record<string, string>>
  >({})
  /**
   * Ticked items whose override will be cleared back to the master default
   * (the request line sends `priceOverrideMinor: null`). Without this the
   * dialog could only set or keep an override — a stale one could never be
   * removed, and it would keep masking the master default forever.
   */
  const [resetIds, setResetIds] = useState<ReadonlySet<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<AssignMenuItemsResponse | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  /**
   * The control that opened the dialog, captured on the first render — before
   * the dialog content mounts and moves focus into itself. There is no
   * `DialogTrigger` here, so Radix has nothing to fall back to: without this,
   * closing would drop focus on `<body>` instead of returning it.
   */
  const [returnFocusTo] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined'
      ? null
      : (document.activeElement as HTMLElement | null),
  )

  const searchRef = useRef<HTMLInputElement>(null)
  const failureRef = useRef<HTMLDivElement>(null)
  const successRef = useRef<HTMLHeadingElement>(null)
  /** Focus moves after React commits, so handlers queue the target here. */
  const focusNext = useRef<'search' | 'failure' | 'success' | null>(null)

  const outlet = outlets.data?.find((entry) => entry.id === outletId) ?? null
  const outletMenu = useQuery({
    queryKey: outletKeys.menu(outletId),
    // Money-bearing payload: parse with the generated Zod schema before use
    // (AGENTS §4.2).
    queryFn: async () =>
      assignmentsControllerListOutletMenuStatus200Schema.parse(
        await assignmentsControllerListOutletMenu({
          path: { outletId },
        }),
      ),
  })
  const menuRowByItem = useMemo(
    () => new Map((outletMenu.data ?? []).map((row) => [row.menuItemId, row])),
    [outletMenu.data],
  )

  const assign = useMutation({
    mutationFn: async (input: {
      outletId: string
      items: AssignMenuItemLine[]
    }) =>
      assignmentsControllerAssignManyStatus201Schema.parse(
        await assignmentsControllerAssignMany({
          path: { outletId: input.outletId },
          body: { items: input.items },
        }),
      ),
    onSuccess: (data) => {
      setResult(data)
      setFailure(null)
      setPriceDrafts({})
      setResetIds(new Set())
      focusNext.current = 'success'
      // One atomic request moved the outlet's revision and its menu rows.
      void queryClient.invalidateQueries({ queryKey: outletKeys.list() })
      void queryClient.invalidateQueries({
        queryKey: outletKeys.menu(data.outletId),
      })
    },
    onError: (cause) => {
      setFailure(describeFailure(cause, items.data ?? []))
      focusNext.current = 'failure'
    },
  })
  const pending = assign.isPending

  useEffect(() => {
    const target = focusNext.current
    if (!target) return
    const node =
      target === 'failure'
        ? failureRef.current
        : target === 'success'
          ? successRef.current
          : searchRef.current
    if (!node) return
    node.focus()
    focusNext.current = null
  }, [result, failure, pending])

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    const all = items.data ?? []
    if (!term) return all
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(term) ||
        item.sku.toLowerCase().includes(term),
    )
  }, [items.data, search])
  const assignableVisible = visible.filter(isAssignable)
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const alreadyAssignedCount = selected.filter(
    (id) => menuRowByItem.get(id)?.active,
  ).length

  function setSelectedItems(next: readonly string[]) {
    setSelected(next)
    onSelectionChange?.([...next])
  }

  function toggleItem(itemId: string, checked: boolean) {
    setSelectedItems(
      checked
        ? [...new Set([...selected, itemId])]
        : selected.filter((id) => id !== itemId),
    )
    if (!checked) {
      // An unticked item's draft must not resurface if it is ticked again.
      const { [itemId]: _dropped, ...rest } = priceDrafts
      setPriceDrafts(rest)
      setResetIds((prev) => {
        if (!prev.has(itemId)) return prev
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
    }
  }

  /** Arm "clear this override" — an armed item has no draft to send. */
  function armReset(itemId: string) {
    const { [itemId]: _dropped, ...rest } = priceDrafts
    setPriceDrafts(rest)
    setResetIds((prev) => new Set(prev).add(itemId))
  }

  /** Back to typing a price for an armed item. */
  function disarmReset(itemId: string) {
    setResetIds((prev) => {
      if (!prev.has(itemId)) return prev
      const next = new Set(prev)
      next.delete(itemId)
      return next
    })
  }

  function selectAllVisible() {
    setSelectedItems([
      ...selected,
      ...assignableVisible
        .map((item) => item.id)
        .filter((id) => !selectedSet.has(id)),
    ])
  }

  /**
   * One request line per selected item; an empty draft sends no override, an
   * armed reset sends `null` to clear it. The operator typed dollars — the
   * wire speaks minor units (PRD §1.3).
   */
  function buildLines(ids: readonly string[]): AssignMenuItemLine[] {
    return ids.map((id) => {
      if (resetIds.has(id)) return { menuItemId: id, priceOverrideMinor: null }
      const minor = majorToMinor(priceDrafts[id] ?? '')
      return minor
        ? { menuItemId: id, priceOverrideMinor: minor }
        : { menuItemId: id }
    })
  }

  /** UX-only guard (AGENTS §4.2): the backend re-validates minor units. */
  function validateDrafts(): Failure | null {
    for (const id of selected) {
      if (resetIds.has(id)) continue
      const price = priceDrafts[id]?.trim()
      if (!price) continue
      if (majorToMinor(price) !== null) continue
      const name = (items.data ?? []).find((item) => item.id === id)?.name
      return {
        title: 'Check the price fields.',
        detail: `${name ?? 'One item'}: the price must be a dollar amount with up to two decimals (e.g. 10.50). Leave it empty to keep the current price.`,
        removableIds: [],
      }
    }
    return null
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selected.length === 0 || pending) return
    const invalid = validateDrafts()
    if (invalid) {
      setFailure(invalid)
      focusNext.current = 'failure'
      return
    }
    setFailure(null)
    assign.mutate({ outletId, items: buildLines(selected) })
  }

  /** Drop the rejected items and resend straight away when something is left. */
  function removeRejected() {
    if (!failure) return
    const drop = new Set(failure.removableIds)
    const next = selected.filter((id) => !drop.has(id))
    setSelected(next)
    setResetIds((prev) => new Set([...prev].filter((id) => !drop.has(id))))
    setFailure(null)
    focusNext.current = 'search'
    if (next.length > 0) assign.mutate({ outletId, items: buildLines(next) })
  }

  function close() {
    if (pending) return
    // A finished assignment clears the page selection; a cancelled one keeps it.
    if (result) onSelectionChange?.([])
    if (result && result.assignedCount > 0) {
      toastSuccess(
        `${count(result.assignedCount, 'item')} assigned to ${outlet?.name ?? 'the outlet'}`,
      )
    }
    setOpen(false)
  }

  // Pending first: the live region then announces the work in flight.
  const statusLine = pending
    ? `Assigning ${count(selected.length, 'item')} to ${outlet?.name ?? 'the outlet'}…`
    : selected.length === 0
      ? 'Select at least one item.'
      : `${count(selected.length, 'item')} selected → ${outlet?.name ?? 'this outlet'}`
  const canSubmit = selected.length > 0 && !pending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <DialogContent
        className="max-w-2xl"
        closeButtonDisabled={pending}
        onEscapeKeyDown={(event) => {
          // Keep the result on screen: the request is already in flight.
          if (pending) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          // Radix would focus a `DialogTrigger` there is none of; do it by hand.
          event.preventDefault()
          const target =
            returnFocusTo?.isConnected && !returnFocusTo.matches(':disabled')
              ? returnFocusTo
              : fallbackFocusRef?.current
          target?.focus()
          onClosed()
        }}
        onOpenAutoFocus={(event) => {
          // The outlet is already chosen, so the item search leads.
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <DialogTitle>Assign items to {outlet?.name ?? 'an outlet'}</DialogTitle>
        <DialogDescription>
          Set a price for each item, leave it empty to keep its current one, or
          reset an outlet override back to the master default. Everything
          commits together, in one catalog revision per item.
        </DialogDescription>

        {result ? (
          <SuccessPanel
            result={result}
            outletName={outlet?.name ?? null}
            headingRef={successRef}
            onDone={close}
            onContinue={() => {
              // Stay on this outlet and pick a fresh set of items.
              setResult(null)
              setSelectedItems([])
              setSearch('')
              focusNext.current = 'search'
            }}
          />
        ) : (
          <form
            onSubmit={handleSubmit}
            aria-busy={pending}
            className="flex min-h-0 flex-col gap-4"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-hairline px-3 py-2.5">
              <span className="kicker m-0">Outlet</span>
              <span className="text-sm font-medium text-ink">
                {outlet?.name ?? 'Loading…'}
              </span>
              {outlet ? (
                <span className="text-xs text-body">
                  Code {outlet.code} · {outlet.timezone} · rev{' '}
                  <span className="money">{outlet.catalogRevision}</span>
                </span>
              ) : null}
              {outlet?.status === 'SUSPENDED' ? (
                <span className="badge-pill badge-neutral normal-case tracking-normal">
                  Suspended
                </span>
              ) : null}
            </div>

            <section
              aria-labelledby={`${baseId}-items-title`}
              className="min-w-0"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id={`${baseId}-items-title`} className="kicker m-0">
                  Items
                </h3>
                <div className="flex items-center gap-1 text-xs">
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    disabled={
                      assignableVisible.length > 0 &&
                      assignableVisible.every((item) =>
                        selectedSet.has(item.id),
                      )
                    }
                    className="rounded-full px-2 py-1 font-medium text-ink hover:bg-surface-strong disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60"
                  >
                    Select all
                  </button>
                  <span aria-hidden="true" className="text-muted-soft">
                    ·
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedItems([])}
                    disabled={selected.length === 0}
                    className="rounded-full px-2 py-1 font-medium text-ink hover:bg-surface-strong disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="relative">
                <SearchIcon
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  ref={searchRef}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or SKU"
                  aria-label="Search items by name or SKU"
                  className="form-input pr-3 pl-9 text-sm font-normal"
                />
              </div>

              {items.isPending ? (
                <ul
                  className="m-0 mt-2 max-h-80 list-none overflow-y-auto rounded-xl border border-hairline p-1"
                  aria-busy="true"
                  aria-label="Menu items"
                >
                  {[0, 1, 2, 3].map((row) => (
                    <li key={row} className="flex items-center gap-3 px-2 py-2">
                      <span className="size-[18px] shrink-0 animate-pulse rounded-[5px] bg-surface-strong motion-reduce:animate-none!" />
                      <span className="h-3 flex-1 animate-pulse rounded-full bg-surface-strong motion-reduce:animate-none!" />
                    </li>
                  ))}
                  <li className="sr-only">Loading items…</li>
                </ul>
              ) : items.isError ? (
                <LoadFailure
                  message={
                    items.error instanceof ApiError
                      ? `${items.error.code}: ${items.error.message}`
                      : 'Failed to load items.'
                  }
                  onRetry={() => void items.refetch()}
                />
              ) : visible.length === 0 ? (
                <p className="m-0 mt-2 rounded-xl border border-hairline px-4 py-6 text-center text-sm text-body">
                  {search
                    ? 'No items match this search.'
                    : 'No master items yet. Create some on the Menu page first.'}
                </p>
              ) : (
                <ul
                  className="m-0 mt-2 max-h-80 list-none overflow-y-auto rounded-xl border border-hairline p-1"
                  aria-label="Menu items"
                >
                  {visible.map((item) => {
                    const checked = selectedSet.has(item.id)
                    const assignable = isAssignable(item)
                    const menuRow = menuRowByItem.get(item.id)
                    const override = menuRow?.priceOverrideMinor ?? null
                    const currentPrice = menuRow
                      ? menuRow.effectivePriceMinor
                      : item.defaultPriceMinor
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          'rounded-lg px-1 py-1 transition-colors',
                          checked && 'bg-surface-strong',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <label
                            className={cn(
                              'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 py-1 transition-colors',
                              !assignable && 'cursor-not-allowed',
                              assignable &&
                                !checked &&
                                'hover:bg-surface-strong',
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!assignable}
                              onCheckedChange={(next) =>
                                toggleItem(item.id, next === true)
                              }
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                className="block truncate text-sm font-medium text-ink"
                                title={item.name}
                              >
                                {item.name}
                              </span>
                              <span className="block truncate text-xs text-body">
                                {item.sku} · {item.categoryName}
                                {assignable ? '' : ' · archived'}
                              </span>
                            </span>
                            {menuRow?.active ? (
                              <span className="badge-pill badge-neutral shrink-0 normal-case tracking-normal">
                                Assigned
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                'money shrink-0 text-sm',
                                override !== null ? 'text-ink' : 'text-body',
                              )}
                              title={
                                override !== null
                                  ? `Outlet override ${formatMinor(override, item.currencyCode)}`
                                  : 'Master default price'
                              }
                            >
                              {formatMinor(currentPrice, item.currencyCode)}
                            </span>
                          </label>
                          {checked ? (
                            resetIds.has(item.id) ? (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => disarmReset(item.id)}
                                aria-label={`Override cleared for ${item.name}; it will use the master default ${formatMinor(item.defaultPriceMinor, item.currencyCode)}. Activate to type a price instead.`}
                                title={`This assignment will use the master default ${formatMinor(item.defaultPriceMinor, item.currencyCode)}. Click to type a price instead.`}
                                className="badge-pill badge-neutral normal-case tracking-normal shrink-0 rounded-full disabled:opacity-50"
                              >
                                <RotateCcwIcon
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                <span className="money">
                                  Default{' '}
                                  {formatMinor(
                                    item.defaultPriceMinor,
                                    item.currencyCode,
                                  )}
                                </span>
                              </button>
                            ) : (
                              <>
                                <input
                                  value={priceDrafts[item.id] ?? ''}
                                  disabled={pending}
                                  onChange={(event) =>
                                    setPriceDrafts({
                                      ...priceDrafts,
                                      [item.id]: event.target.value,
                                    })
                                  }
                                  placeholder="keep"
                                  inputMode="decimal"
                                  autoComplete="off"
                                  aria-label={`Price override for ${item.name} in dollars; leave empty to keep ${formatMinor(currentPrice, item.currencyCode)}`}
                                  title={`Current price ${formatMinor(currentPrice, item.currencyCode)}${override !== null ? ' (outlet override)' : ''}. Enter a dollar amount with up to two decimals (e.g. 10.50), or leave empty to keep it.`}
                                  className="form-input money h-9 w-28 shrink-0 px-2.5 py-1.5 text-sm font-normal disabled:opacity-50"
                                />
                                {override !== null ? (
                                  <button
                                    type="button"
                                    disabled={pending}
                                    onClick={() => armReset(item.id)}
                                    aria-label={`Clear the price override for ${item.name} and use the master default ${formatMinor(item.defaultPriceMinor, item.currencyCode)}`}
                                    title={`Clear this outlet's override (${formatMinor(override, item.currencyCode)}) and use the master default ${formatMinor(item.defaultPriceMinor, item.currencyCode)}.`}
                                    className="shrink-0 rounded-full p-1.5 text-body hover:bg-surface-strong hover:text-ink disabled:opacity-50"
                                  >
                                    <RotateCcwIcon
                                      aria-hidden="true"
                                      className="size-3.5"
                                    />
                                  </button>
                                ) : null}
                              </>
                            )
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {failure && !pending ? (
              // Ink/body text on the tinted panel: error-red copy is only ~4.1:1
              // here, below the 4.5:1 text minimum. The accent bar marks it.
              <div
                ref={failureRef}
                role="alert"
                tabIndex={-1}
                className="rounded-r-lg border-l-2 border-error bg-error/10 px-3 py-2 text-sm outline-none"
              >
                <p className="m-0 font-medium text-ink">{failure.title}</p>
                <p className="m-0 text-body">{failure.detail}</p>
                {failure.removableIds.length > 0 ? (
                  <button
                    type="button"
                    onClick={removeRejected}
                    className="btn-outline btn-sm mt-2"
                  >
                    Remove {count(failure.removableIds.length, 'item')} and
                    retry
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
              <div className="min-w-0">
                <p
                  role="status"
                  aria-atomic="true"
                  className="m-0 text-sm text-body"
                >
                  {statusLine}
                </p>
                {alreadyAssignedCount > 0 ? (
                  <p className="m-0 text-xs text-muted-foreground">
                    {count(alreadyAssignedCount, 'item')} already assigned —
                    left as is.
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={pending}
                  className="btn-outline"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  aria-busy={pending}
                  disabled={!canSubmit}
                  className="btn-primary min-w-40"
                >
                  {pending ? (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="size-4 animate-spin motion-reduce:animate-none!"
                    />
                  ) : null}
                  {pending
                    ? 'Assigning…'
                    : `Assign ${count(selected.length, 'item')}`}
                </button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** What one atomic assignment achieved — replaces the form so the result is unmissable. */
function SuccessPanel({
  result,
  outletName,
  headingRef,
  onDone,
  onContinue,
}: {
  result: AssignMenuItemsResponse
  outletName: string | null
  headingRef: RefObject<HTMLHeadingElement | null>
  onDone: () => void
  /** Keeps the outlet and returns to the form for the next batch. */
  onContinue: () => void
}) {
  const name = outletName ?? 'the outlet'
  const changed = result.assignedCount > 0
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <CircleCheckIcon aria-hidden="true" className="size-10 text-success" />
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="m-0 font-display text-title-md text-ink outline-none"
      >
        {changed
          ? `Assigned ${count(result.assignedCount, 'item')} to ${name}`
          : 'Already up to date'}
      </h3>
      <p className="m-0 text-sm text-body">
        {changed
          ? `${name} is now at catalog revision ${result.catalogRevision} and receives ${result.assignedCount === 1 ? 'it' : 'them'} on its next menu sync, usually within a minute.`
          : `${count(result.unchangedCount, 'item')} ${result.unchangedCount === 1 ? 'was' : 'were'} already assigned to ${name}. Nothing changed.`}
      </p>
      {changed && result.unchangedCount > 0 ? (
        <p className="m-0 text-sm text-body">
          {count(result.unchangedCount, 'item')}{' '}
          {result.unchangedCount === 1 ? 'was' : 'were'} already assigned and
          left unchanged.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onDone} className="btn-primary">
          Done
        </button>
        <button type="button" onClick={onContinue} className="btn-outline">
          Assign more items
        </button>
      </div>
    </div>
  )
}

function LoadFailure({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="mt-2 rounded-xl border border-hairline px-4 py-3 text-sm text-body">
      <p role="alert" className="m-0">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="btn-outline btn-sm mt-2"
      >
        Retry
      </button>
    </div>
  )
}
