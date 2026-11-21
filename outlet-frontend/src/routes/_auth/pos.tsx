import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import type { SaleResponse } from '#/api/generated/types/SaleResponse'
import { fetchMenu, submitSale } from '#/features/pos/api'
import type { MenuItem } from '#/features/pos/api'
import { posKeys } from '#/features/pos/keys'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'

export const Route = createFileRoute('/_auth/pos')({ component: PosPage })

/** Cart line quantities: positive integers bounded by visible stock. */
const cartSchema = z.record(z.string().uuid(), z.number().int().min(1))

/**
 * Financial-action discipline (AGENTS §4.4): the idempotency key lives in a
 * ref — minted on the first attempt of a sale, reused verbatim on every
 * retry/time-out, and cleared only on a committed response or explicit
 * abandonment. Never a second key for the same attempt.
 */
type KeyRef = { current: string | null }

function mintIdempotencyKey(register: string): string {
  return `pos-${register}-${globalThis.crypto.randomUUID()}`
}

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
  // (price/stock/total) renders from server data only.
  const [cart, setCart] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<SaleResponse | null>(null)
  const idempotencyKeyRef = useRef<string | null>(null) as KeyRef
  const [keyPreview, setKeyPreview] = useState<string | null>(null)

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
      // One key per attempt: mint on first submit, keep stable on retries.
      idempotencyKeyRef.current ??= mintIdempotencyKey('register')
      setKeyPreview(idempotencyKeyRef.current)
      return submitSale(idempotencyKeyRef.current, lines)
    },
    onSuccess: (sale) => {
      setReceipt(sale)
      setCart({})
      setError(null)
      // Retire the attempt: the next sale is a new attempt with a new key.
      idempotencyKeyRef.current = null
      setKeyPreview(null)
      void queryClient.invalidateQueries({ queryKey: posKeys.menu() })
    },
    onError: (cause) => setError(errorFor(cause)),
    // No retry-on-error at the mutation layer: the human decides, and the
    // same key ref guarantees the retry is idempotent.
  })

  if (!canSell) {
    return (
      <main className="page-wrap py-16">
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          You do not have permission to run sales on this register.
        </p>
      </main>
    )
  }

  const items = menu.data ?? []

  function addToCart(menuItemId: string): void {
    setError(null)
    setCart((current) => {
      const next = { ...current, [menuItemId]: (current[menuItemId] ?? 0) + 1 }
      cartSchema.parse(next) // UX-only guard (AGENTS §4.2)
      return next
    })
  }

  function setQuantity(menuItemId: string, quantity: number): void {
    setCart((current) => {
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
    idempotencyKeyRef.current = null
    setKeyPreview(null)
    setError(null)
  }

  const currency = items[0]?.currencyCode ?? 'USD'

  return (
    <main className="page-wrap py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="island-kicker mb-2">Register</p>
          <h1 className="m-0 text-2xl font-semibold text-[var(--sea-ink)]">
            Point of sale
          </h1>
        </div>
        <button
          type="button"
          className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold text-[var(--sea-ink)]"
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
          className="island-shell mb-6 rounded-2xl p-6 print:border-0 print:shadow-none"
          aria-live="polite"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="island-kicker m-0">Receipt confirmed</p>
            <span className="rounded-full bg-[rgba(52,199,89,0.15)] px-3 py-1 text-xs font-semibold text-[#1d7a3f]">
              {receipt.status} · sync {receipt.syncStatus}
            </span>
          </div>
          <h2 className="m-0 mb-1 font-mono text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
            {receipt.receiptNo}
          </h2>
          <p className="m-0 mb-4 text-xs text-[var(--sea-ink-soft)]">
            Sold {new Date(receipt.soldAt).toLocaleString()} · catalog revision{' '}
            {receipt.catalogRevision}
          </p>
          <table className="mb-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
                <th className="py-2 pr-4">Item</th>
                <th className="py-2 pr-4">Qty</th>
                <th className="py-2 pr-4">Unit</th>
                <th className="py-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((item) => (
                <tr
                  key={item.saleItemId}
                  className="border-b border-[var(--line)]/60"
                >
                  <td className="py-2 pr-4 font-medium text-[var(--sea-ink)]">
                    {item.name}
                    <span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
                      {item.sku}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{item.quantity}</td>
                  <td className="py-2 pr-4">
                    {formatMinor(item.unitPriceMinor, receipt.currencyCode)}
                  </td>
                  <td className="py-2 text-right">
                    {formatMinor(item.subtotalMinor, receipt.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td
                  colSpan={3}
                  className="pt-3 text-right text-sm font-semibold"
                >
                  Total (server-computed)
                </td>
                <td className="pt-3 text-right font-mono text-base font-bold">
                  {formatMinor(receipt.totalMinor, receipt.currencyCode)}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="flex flex-wrap gap-2 print:hidden">
            <button
              type="button"
              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white"
              onClick={() => window.print()}
            >
              Print receipt
            </button>
            <button
              type="button"
              className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-5 py-2 text-xs font-semibold text-[var(--sea-ink)]"
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
            <p
              className="island-shell rounded-2xl p-6 text-sm text-[var(--sea-ink-soft)]"
              aria-busy="true"
            >
              Loading menu…
            </p>
          ) : menu.isError ? (
            <p
              role="alert"
              className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
            >
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
                    className="island-shell flex flex-col gap-2 rounded-2xl p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                        {item.name}
                      </h2>
                      <span className="whitespace-nowrap font-mono text-sm font-bold text-[var(--sea-ink)]">
                        {formatMinor(item.unitPriceMinor, item.currencyCode)}
                      </span>
                    </div>
                    <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                      {item.sku} · {item.category}
                    </p>
                    <p
                      className={`m-0 text-xs font-semibold ${
                        remaining > 0 ? 'text-[#1d7a3f]' : 'text-[#a03030]'
                      }`}
                    >
                      {remaining > 0 ? `${remaining} in stock` : 'Out of stock'}
                    </p>
                    <button
                      type="button"
                      className="mt-auto rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-4 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:opacity-40"
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
          className="island-shell h-fit rounded-2xl p-5 lg:sticky lg:top-24"
        >
          <p className="island-kicker mb-3">Cart</p>
          {Object.entries(cart).length === 0 ? (
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
              Scan or tap items to begin.
            </p>
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
                      <p className="m-0 truncate font-medium text-[var(--sea-ink)]">
                        {item.name}
                      </p>
                      <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                        {formatMinor(item.unitPriceMinor, item.currencyCode)}{' '}
                        each
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Remove one ${item.name}`}
                        className="h-7 w-7 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] text-sm font-bold text-[var(--sea-ink)]"
                        onClick={() => setQuantity(menuItemId, quantity - 1)}
                      >
                        −
                      </button>
                      <span className="w-8 text-center font-mono text-sm font-semibold">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${item.name}`}
                        className="h-7 w-7 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] text-sm font-bold text-[var(--sea-ink)] disabled:opacity-40"
                        disabled={quantity >= max}
                        onClick={() => setQuantity(menuItemId, quantity + 1)}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label={`Clear ${item.name}`}
                        className="ml-1 text-xs font-semibold text-[#a03030]"
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
              <div className="mb-4 flex items-center justify-between border-t border-[var(--line)] pt-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
                  Estimated total
                </span>
                <span className="font-mono text-lg font-bold text-[var(--sea-ink)]">
                  {formatMinor(cartTotalMinor, currency)}
                </span>
              </div>
              <p className="m-0 mb-3 text-[11px] leading-relaxed text-[var(--sea-ink-soft)]">
                The register computes the final total. Retries reuse the same
                idempotency key — a double-tap can never double-charge.
              </p>
            </>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mb-3 rounded-lg bg-[rgba(235,87,87,0.12)] px-3 py-2 text-xs text-[#a03030]"
            >
              {error}
            </p>
          ) : null}

          {keyPreview ? (
            <p className="m-0 mb-3 font-mono text-[10px] break-all text-[var(--sea-ink-soft)]">
              attempt key: {keyPreview}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(47,143,131,0.28)] transition hover:brightness-105 disabled:opacity-50"
              disabled={Object.keys(cart).length === 0 || checkout.isPending}
            >
              {checkout.isPending ? 'Charging…' : 'Charge sale'}
            </button>
            {idempotencyKeyRef.current ? (
              <button
                type="button"
                className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2.5 text-xs font-semibold text-[var(--sea-ink)]"
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
