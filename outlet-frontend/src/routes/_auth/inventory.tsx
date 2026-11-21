import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import type { AdjustmentReason } from '#/features/inventory/api'
import { adjustInventory, fetchBalances } from '#/features/inventory/api'
import { inventoryKeys } from '#/features/inventory/keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'

export const Route = createFileRoute('/_auth/inventory')({
  component: InventoryPage,
})

const REASONS: ReadonlyArray<{
  value: AdjustmentReason
  label: string
  hint: string
}> = [
  { value: 'RESTOCK', label: 'Restock', hint: 'positive: goods received' },
  { value: 'WRITE_OFF', label: 'Write-off', hint: 'negative: spoilage/loss' },
  {
    value: 'RECOUNT',
    label: 'Recount',
    hint: 'signed: corrections to the counted figure',
  },
]

const adjustmentSchema = z.object({
  menuItemId: z.string().uuid(),
  reason: z.enum(['RESTOCK', 'WRITE_OFF', 'RECOUNT']),
  // Signed quantity, bounded (mirrors the backend DTO bounds), never zero.
  deltaQuantity: z
    .number()
    .int('Whole units only.')
    .refine((value) => value !== 0, 'Enter a nonzero adjustment.')
    .refine((value) => Math.abs(value) <= 1_000_000, 'Bounded to ±1,000,000.'),
})

function adjustmentError(cause: unknown): string {
  if (cause instanceof ApiError) {
    const suffix = cause.requestId
      ? ` (request ${cause.requestId.slice(0, 8)})`
      : ''
    if (cause.code === 'INSUFFICIENT_STOCK')
      return `That adjustment would take stock below zero — rejected with no changes.${suffix}`
    if (cause.code === 'ITEM_NOT_ASSIGNED')
      return 'This item is not in the local catalog (anymore). Refresh the list.'
    return `${cause.message}${suffix}`
  }
  return 'Adjustment failed. Please try again.'
}

function InventoryPage() {
  const session = useSession()
  const canRead = hasPermission(session.user, 'inventory.read')
  const canAdjust = hasPermission(session.user, 'inventory.adjust')
  const queryClient = useQueryClient()

  const balances = useQuery({
    queryKey: inventoryKeys.balances(),
    queryFn: fetchBalances,
    refetchOnWindowFocus: true,
  })

  // Adjustment dialog state: which row, and the draft input.
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [reason, setReason] = useState<AdjustmentReason>('RESTOCK')
  const [quantity, setQuantity] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const adjust = useMutation({
    mutationFn: adjustInventory,
    onSuccess: (result) => {
      setNotice(
        `Adjustment applied — on-hand is now ${result.quantityOnHand} (version ${result.version}).`,
      )
      closeDialog()
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.balances() })
    },
    onError: (cause) => setFormError(adjustmentError(cause)),
  })

  if (!canRead) {
    return (
      <main className="page-wrap py-16">
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          You do not have permission to view inventory.
        </p>
      </main>
    )
  }

  function closeDialog(): void {
    setAdjustingId(null)
    setQuantity('')
    setFormError(null)
  }

  function openDialog(menuItemId: string): void {
    setNotice(null)
    setAdjustingId(menuItemId)
    setReason('RESTOCK')
    setQuantity('')
    setFormError(null)
  }

  function handleAdjust(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!adjustingId) return
    setFormError(null)
    const parsed = adjustmentSchema.safeParse({
      menuItemId: adjustingId,
      reason,
      deltaQuantity: Number(quantity),
    })
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Invalid adjustment.')
      return
    }
    adjust.mutate(parsed.data)
  }

  const adjustingRow = balances.data?.find(
    (row) => row.menuItemId === adjustingId,
  )

  return (
    <main className="page-wrap py-10">
      <p className="island-kicker mb-2">Back of house</p>
      <h1 className="mb-1 text-2xl font-semibold text-[var(--sea-ink)]">
        Inventory
      </h1>
      <p className="mb-6 mt-1 text-sm text-[var(--sea-ink-soft)]">
        Local balances only — every adjustment is an audited movement.
      </p>

      {notice ? (
        <p
          role="status"
          className="mb-4 rounded-lg bg-[rgba(52,199,89,0.12)] px-3 py-2 text-sm text-[#1d7a3f]"
        >
          {notice}
        </p>
      ) : null}

      {balances.isPending ? (
        <p
          className="island-shell rounded-2xl p-6 text-sm text-[var(--sea-ink-soft)]"
          aria-busy="true"
        >
          Loading balances…
        </p>
      ) : balances.isError ? (
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          Inventory unavailable:{' '}
          {balances.error instanceof Error
            ? balances.error.message
            : 'network error'}
        </p>
      ) : (
        <section className="island-shell overflow-x-auto rounded-2xl p-6">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
                <th className="py-2 pr-4">Item</th>
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">On hand</th>
                <th className="py-2 pr-4">Version</th>
                <th className="py-2 pr-4">Updated</th>
                {canAdjust ? <th className="py-2">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {balances.data.map((row) => (
                <tr
                  key={row.menuItemId}
                  className="border-b border-[var(--line)]/60"
                >
                  <td className="py-2 pr-4 font-medium text-[var(--sea-ink)]">
                    {row.name}
                  </td>
                  <td className="py-2 pr-4 text-[var(--sea-ink-soft)]">
                    {row.sku}
                  </td>
                  <td className="py-2 pr-4 font-mono font-semibold">
                    <span
                      className={row.quantityOnHand > 0 ? '' : 'text-[#a03030]'}
                    >
                      {row.quantityOnHand}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-[var(--sea-ink-soft)]">
                    v{row.version}
                  </td>
                  <td className="py-2 pr-4 text-xs text-[var(--sea-ink-soft)]">
                    {new Date(row.updatedAt).toLocaleString()}
                  </td>
                  {canAdjust ? (
                    <td className="py-2">
                      <button
                        type="button"
                        className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink)]"
                        onClick={() => openDialog(row.menuItemId)}
                      >
                        Adjust
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {adjustingRow ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,30,26,0.45)] p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Adjust stock for ${adjustingRow.name}`}
        >
          <form
            onSubmit={handleAdjust}
            className="island-shell w-full max-w-md rounded-2xl p-6"
          >
            <p className="island-kicker mb-2">Audited adjustment</p>
            <h2 className="mb-1 text-lg font-semibold text-[var(--sea-ink)]">
              {adjustingRow.name}
            </h2>
            <p className="mb-4 mt-0 text-xs text-[var(--sea-ink-soft)]">
              {adjustingRow.sku} · on hand {adjustingRow.quantityOnHand} · every
              change is recorded with your account and the request ID.
            </p>

            <fieldset className="mb-4 m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
                Reason
              </legend>
              {REASONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    reason === option.value
                      ? 'border-[#56c6be] bg-[rgba(86,198,190,0.10)]'
                      : 'border-[var(--chip-line)] bg-[var(--chip-bg)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="reason"
                    value={option.value}
                    checked={reason === option.value}
                    onChange={() => setReason(option.value)}
                  />
                  <span className="font-semibold text-[var(--sea-ink)]">
                    {option.label}
                  </span>
                  <span className="ml-auto text-xs text-[var(--sea-ink-soft)]">
                    {option.hint}
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="mb-4 flex flex-col gap-1 text-sm font-medium">
              Signed quantity change
              <input
                type="number"
                step="1"
                required
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder={reason === 'RESTOCK' ? 'e.g. 50' : 'e.g. -3'}
                className="rounded-lg border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-2 font-mono text-sm font-normal text-[var(--sea-ink)] outline-none focus:border-[#56c6be]"
              />
            </label>

            {formError ? (
              <p
                role="alert"
                className="mb-3 rounded-lg bg-[rgba(235,87,87,0.12)] px-3 py-2 text-xs text-[#a03030]"
              >
                {formError}
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={adjust.isPending}
                className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                {adjust.isPending ? 'Applying…' : 'Apply adjustment'}
              </button>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold text-[var(--sea-ink)]"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  )
}
