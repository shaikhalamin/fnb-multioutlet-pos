import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import type { SaleResponse } from '#/api/generated/types/SaleResponse'
import { fetchMenu, submitSale } from '#/features/pos/api'
import type { MenuItem } from '#/features/pos/api'
import { mintIdempotencyKey, saleAttemptStore } from '#/features/pos/attempt'
import { posKeys } from '#/features/pos/keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'

export const Route = createFileRoute('/_auth/pos')({ component: PosPage })

/** Cart line quantities: positive integers bounded by visible stock. */
const cartSchema = z.record(z.string().uuid(), z.number().int().min(1))

/**
 * Financial-action discipline (AGENTS §4.4, outlet-AGENTS rule 4): the
 * idempotency key and its cart lines live in the session-scoped attempt
 * store — minted on the first attempt of a sale, reused verbatim on every
 * retry/time-out (even across navigation away and back), and cleared only
 * on a committed response or explicit abandonment. Never a second key for
 * the same attempt.
 */

function errorFor(cause: unknown): string {
  if (cause instanceof ApiError) {
    const detail = cause.details as
      | {
          menuItemId?: string
          requestedQuantity?: number
          availableQuantity?: number
        }
      | undefined
    const suffix = cause.requestId
      ? ` (request ${cause.requestId.slice(0, 8)})`
      : ''
    switch (cause.code) {
      case 'INSUFFICIENT_STOCK':
        return detail?.menuItemId
          ? `Not enough stock for an item (need ${detail.requestedQuantity}, have ${detail.availableQuantity}). Sale rolled back.${suffix}`
          : `Not enough stock. Sale rolled back.${suffix}`
      case 'ITEM_INACTIVE':
        return 'An item in the cart was deactivated. Refresh the menu and retry.'
      case 'ITEM_NOT_ASSIGNED':
        return 'An item in the cart is no longer assigned to this outlet.'
      case 'SYNC_TEMPORARILY_UNAVAILABLE':
        return 'Menu sync is stale — sales are blocked until the catalog is refreshed.'
      case 'TIMEOUT':
      case 'NETWORK_ERROR':
        return 'The register did not confirm the sale. Retrying reuses the same key — it can never double-charge.'
      default:
        return `${cause.message}${suffix}`
    }
  }
  return 'Checkout failed. Please try again.'
}

function PosPage() {
  const session = useSession()
  const canSell = hasPermission(session.user, 'sales.create')
  const queryClient = useQueryClient()

  const menu = useQuery({
    queryKey: posKeys.menu(),
    queryFn: fetchMenu,
    // Live stock on the tiles (PRD §11): refetch when the window regains
    // focus; never optimistic — stock comes from the server only.
    refetchOnWindowFocus: true,
  })

  // Cart: menuItemId → quantity. Client state, but every financial truth
  // (price/stock/total) renders from server data only. A pending attempt
  // restores its cart so a retry after navigation back to /pos replays the
  // same key with the same lines.
  const [cart, setCart] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (saleAttemptStore.get()?.lines ?? []).map((line) => [
        line.menuItemId,
        line.quantity,
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<SaleResponse | null>(null)
  const [keyPreview, setKeyPreview] = useState<string | null>(
    () => saleAttemptStore.get()?.idempotencyKey ?? null,
  )

  const byId = useMemo(() => {
    const map = new Map<string, MenuItem>()
    for (const item of menu.data ?? []) map.set(item.menuItemId, item)
    return map
  }, [menu.data])

  // Preview math in exact BigInt (AGENTS §4.3): string in, string out.
  const cartTotalMinor = useMemo(() => {
    let total = 0n
    for (const [menuItemId, quantity] of Object.entries(cart)) {
      const item = byId.get(menuItemId)
      if (item) total += BigInt(item.unitPriceMinor) * BigInt(quantity)
    }
    return total.toString()
  }, [cart, byId])

  const checkout = useMutation({
    mutationFn: (lines: Array<{ menuItemId: string; quantity: number }>) => {
      // One key per attempt: a pending attempt replays its frozen lines and
      // key (identical request hash); a fresh attempt mints a new key.
      const pending = saleAttemptStore.get()
      const attempt = pending ?? {
        idempotencyKey: mintIdempotencyKey('register'),
        lines,
      }
      saleAttemptStore.set(attempt)
      setKeyPreview(attempt.idempotencyKey)
      return submitSale(attempt.idempotencyKey, attempt.lines)
    },
    onSuccess: (sale) => {
      setReceipt(sale)
      setCart({})
      setError(null)
      // Retire the attempt: the next sale is a new attempt with a new key.
      saleAttemptStore.clear()
      setKeyPreview(null)
      void queryClient.invalidateQueries({ queryKey: posKeys.menu() })
    },
    onError: (cause) => setError(errorFor(cause)),
    // No retry-on-error at the mutation layer: the human decides, and the
    // stable attempt key guarantees the retry is idempotent.
  })

  if (!canSell) {
    return (
      <main className="page-wrap py-16">
        <p role="alert" className="card-panel p-6 text-sm text-error">
          You do not have permission to run sales on this register.
        </p>
      </main>
    )
  }

  const items = menu.data ?? []

  function editCart(
    apply: (current: Record<string, number>) => Record<string, number>,
  ): void {
    setError(null)
    // Editing the cart after a failed attempt changes the attempted sale —
    // retire the pending key so the next charge mints a fresh attempt.
    if (saleAttemptStore.get()) {
      saleAttemptStore.clear()
      setKeyPreview(null)
    }
    setCart(apply)
  }

  function addToCart(menuItemId: string): void {
    editCart((current) => {
      const next = { ...current, [menuItemId]: (current[menuItemId] ?? 0) + 1 }
      cartSchema.parse(next) // UX-only guard (AGENTS §4.2)
      return next
    })
  }

  function setQuantity(menuItemId: string, quantity: number): void {
    editCart((current) => {
      const next = { ...current }
      if (quantity <= 0) delete next[menuItemId]
      else next[menuItemId] = quantity
      return next
    })
  }

  function handleCheckout(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (Object.keys(cart).length === 0) return
    setError(null)
    const lines = Object.entries(cart).map(([menuItemId, quantity]) => ({
      menuItemId,
      quantity,
    }))
    checkout.mutate(lines)
  }

  function abandonAttempt(): void {
    saleAttemptStore.clear()
    setKeyPreview(null)
    setError(null)
  }

  const currency = items[0]?.currencyCode ?? 'USD'

  return (
    <main className="page-wrap py-10">
      <div className="relative mb-6 flex flex-wrap items-end justify-between gap-3">
        <span
          aria-hidden="true"
          className="orb orb-peach -top-8 right-16 h-40 w-40"
        />
        <div className="relative">
          <p className="kicker mb-2">Register</p>
          <h1 className="m-0 font-display text-display-md text-ink">
            Point of sale
          </h1>
        </div>
        <button
          type="button"
          className="btn-outline btn-sm relative"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: posKeys.menu() })
          }
          disabled={menu.isFetching}
        >
          {menu.isFetching ? 'Refreshing…' : 'Refresh stock'}
        </button>
      </div>

      {receipt ? (
        <section
          className="card-panel mb-6 p-6 print:border-0 print:shadow-none"
          aria-live="polite"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="kicker m-0">Receipt confirmed</p>
            <span className="badge-pill badge-success">
              {receipt.status} · sync {receipt.syncStatus}
            </span>
          </div>
          <h2 className="money m-0 mb-1 font-display text-display-sm text-ink">
            {receipt.receiptNo}
          </h2>
          <p className="m-0 mb-4 text-xs text-body">
            Sold {new Date(receipt.soldAt).toLocaleString()} · catalog revision{' '}
            {receipt.catalogRevision}
          </p>
          <table className="mb-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <th className="kicker py-2 pr-4">Item</th>
                <th className="kicker py-2 pr-4">Qty</th>
                <th className="kicker py-2 pr-4">Unit</th>
                <th className="kicker py-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((item) => (
                <tr
                  key={item.saleItemId}
                  className="border-b border-hairline-soft"
                >
                  <td className="py-2 pr-4 font-medium text-ink">
                    {item.name}
                    <span className="ml-2 text-xs text-body">{item.sku}</span>
                  </td>
                  <td className="money py-2 pr-4">{item.quantity}</td>
                  <td className="money py-2 pr-4">
                    {formatMinor(item.unitPriceMinor, receipt.currencyCode)}
                  </td>
                  <td className="money py-2 text-right">
                    {formatMinor(item.subtotalMinor, receipt.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="pt-3 text-right text-sm font-medium">
                  Total (server-computed)
                </td>
                <td className="money pt-3 text-right text-base font-semibold">
                  {formatMinor(receipt.totalMinor, receipt.currencyCode)}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => window.print()}
            >
              Print receipt
            </button>
            <button
              type="button"
              className="btn-outline btn-sm"
              onClick={() => setReceipt(null)}
            >
              New sale
            </button>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section>
          {menu.isPending ? (
            <p className="card-panel p-6 text-sm text-body" aria-busy="true">
              Loading menu…
            </p>
          ) : menu.isError ? (
            <p role="alert" className="card-panel p-6 text-sm text-error">
              Menu unavailable:{' '}
              {menu.error instanceof Error
                ? menu.error.message
                : 'network error'}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((item) => {
                const inCart = cart[item.menuItemId] ?? 0
                const remaining = item.availableQuantity - inCart
                return (
                  <article
                    key={item.menuItemId}
                    className="card-panel flex flex-col gap-2 p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="m-0 text-sm font-medium text-ink">
                        {item.name}
                      </h2>
                      <span className="money whitespace-nowrap text-sm font-semibold text-ink">
                        {formatMinor(item.unitPriceMinor, item.currencyCode)}
                      </span>
                    </div>
                    <p className="m-0 text-xs text-body">
                      {item.sku} · {item.category}
                    </p>
                    <p
                      className={`m-0 text-xs font-medium ${
                        remaining > 0 ? 'text-success' : 'text-error'
                      }`}
                    >
                      {remaining > 0 ? `${remaining} in stock` : 'Out of stock'}
                    </p>
                    <button
                      type="button"
                      className="btn-primary btn-sm mt-auto"
                      disabled={remaining <= 0 || checkout.isPending}
                      onClick={() => addToCart(item.menuItemId)}
                    >
                      Add to cart
                    </button>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <form
          onSubmit={handleCheckout}
          className="card-panel h-fit p-5 lg:sticky lg:top-24"
        >
          <p className="kicker mb-3">Cart</p>
          {Object.entries(cart).length === 0 ? (
            <p className="m-0 text-sm text-body">Scan or tap items to begin.</p>
          ) : (
            <ul className="m-0 mb-4 flex list-none flex-col gap-3 p-0">
              {Object.entries(cart).map(([menuItemId, quantity]) => {
                const item = byId.get(menuItemId)
                if (!item) return null
                const max = item.availableQuantity
                return (
                  <li
                    key={menuItemId}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="m-0 truncate font-medium text-ink">
                        {item.name}
                      </p>
                      <p className="money m-0 text-xs text-body">
                        {formatMinor(item.unitPriceMinor, item.currencyCode)}{' '}
                        each
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Remove one ${item.name}`}
                        className="h-7 w-7 rounded-full border border-hairline-strong bg-surface-card text-sm font-medium text-ink"
                        onClick={() => setQuantity(menuItemId, quantity - 1)}
                      >
                        −
                      </button>
                      <span className="money w-8 text-center text-sm font-semibold">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${item.name}`}
                        className="h-7 w-7 rounded-full border border-hairline-strong bg-surface-card text-sm font-medium text-ink disabled:opacity-40"
                        disabled={quantity >= max}
                        onClick={() => setQuantity(menuItemId, quantity + 1)}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label={`Clear ${item.name}`}
                        className="ml-1 text-xs font-medium text-error hover:underline"
                        onClick={() => setQuantity(menuItemId, 0)}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {Object.entries(cart).length > 0 ? (
            <>
              <div className="mb-4 flex items-center justify-between border-t border-hairline pt-3">
                <span className="kicker">Estimated total</span>
                <span className="money text-lg font-semibold text-ink">
                  {formatMinor(cartTotalMinor, currency)}
                </span>
              </div>
              <p className="m-0 mb-3 text-[11px] leading-relaxed text-body">
                The register computes the final total. Retries reuse the same
                idempotency key — a double-tap can never double-charge.
              </p>
            </>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-xs text-error"
            >
              {error}
            </p>
          ) : null}

          {keyPreview ? (
            <p className="money m-0 mb-3 text-[10px] break-all text-muted-foreground">
              attempt key: {keyPreview}
            </p>
          ) : null}

          {/* Checkout zone: the charge pill fills the row (POS convention —
              one unmistakable, ≥40px full-width touch target) and keeps
              breathing room from the empty-state hint / totals above. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={Object.keys(cart).length === 0 || checkout.isPending}
            >
              {checkout.isPending ? 'Charging…' : 'Charge sale'}
            </button>
            {keyPreview ? (
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={abandonAttempt}
              >
                Abandon attempt
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </main>
  )
}
