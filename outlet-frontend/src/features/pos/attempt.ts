/**
 * Session-scoped sale attempt (AGENTS §4.4 / outlet-AGENTS rule 4): the
 * idempotency key and the cart lines it was minted for survive navigation
 * away from /pos — returning to a pending attempt keeps retrying the SAME
 * key with the SAME lines (a changed hash would 409). Cleared only by a
 * committed response or explicit abandonment, so a second key is never
 * minted for the same attempted sale (AT-07/AT-08). In-memory like the
 * session store: no financial state in localStorage.
 */
export type SaleAttempt = {
  idempotencyKey: string
  lines: Array<{ menuItemId: string; quantity: number }>
}

let attempt: SaleAttempt | null = null

export const saleAttemptStore = {
  get(): SaleAttempt | null {
    return attempt
  },
  set(next: SaleAttempt): void {
    attempt = next
  },
  clear(): void {
    attempt = null
  },
}

/** Mints the register-scoped key for a genuinely new sale attempt. */
export function mintIdempotencyKey(register: string): string {
  return `pos-${register}-${globalThis.crypto.randomUUID()}`
}
