import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Renders an integer minor-unit money string (PRD §1.3) for display only —
 * money stays a string end-to-end and is never parsed into application state
 * (AGENTS.md §4.3). Formatting is pure string/integer math: the minor-units
 * value is never routed through `Number()` (float) — exact beyond 2^53 minor
 * units, where `Number(minor) / 100` would silently corrupt the amount.
 */
export function formatMinor(
  minor: string | null | undefined,
  currencyCode = 'USD',
): string {
  if (minor === null || minor === undefined) return '—'
  const raw = minor.trim()
  // Canonical money shape (PRD §1.3): ^(?:0|[1-9][0-9]*)$ — anything else is
  // not a valid minor-units value; render the placeholder instead of guessing.
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return '—'
  const cents = raw.slice(-2).padStart(2, '0')
  const whole = (raw.slice(0, -2) || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const formatted = `${whole}.${cents}`
  return currencyCode === 'USD'
    ? `$${formatted}`
    : `${formatted} ${currencyCode}`
}

/**
 * Parses an operator-typed major-unit amount ("3", "10.5", "0.99") into the
 * canonical integer minor-units decimal string the API speaks ("300", "1050",
 * "99"). Money inputs take dollars — humans must never be asked for minor
 * units (a "$3" item typed as 3 stores $0.03). Pure string/BigInt math
 * (AGENTS.md §4.3): never routed through `Number()`. Returns null when the
 * text is not a nonnegative amount with at most two decimals.
 */
export function majorToMinor(input: string): string | null {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const [, whole = '0', fraction = ''] = match
  const cents = (fraction + '00').slice(0, 2)
  return (BigInt(whole) * 100n + BigInt(cents)).toString()
}

/**
 * Renders an integer minor-units string as the plain major-unit amount the
 * money inputs use ("1050" → "10.50", "99" → "0.99"), so seeding an edit form
 * from stored data never reinterprets the value. Input values only — display
 * surfaces keep `formatMinor`.
 */
export function minorToMajor(minor: string): string {
  const raw = minor.trim()
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return ''
  const cents = raw.slice(-2).padStart(2, '0')
  const whole = raw.slice(0, -2) || '0'
  return `${whole}.${cents}`
}

/**
 * Parses a canonical minor-units decimal string ("1200") into a bigint, or
 * null when the value is not canonical — the only way money enters
 * arithmetic (AGENTS.md §4.3: bigint only, never `Number()`).
 */
export function minorToBigInt(minor: string | null | undefined): bigint | null {
  const raw = minor?.trim() ?? ''
  return /^(0|[1-9][0-9]*)$/.test(raw) ? BigInt(raw) : null
}

/**
 * One part's share of a total, in basis points (0–10000) — the proportional
 * width behind report bars. The division is bigint math; only its bounded
 * result (no longer a money value) is returned as a number. Null when the
 * total is zero or either side is not a canonical minor-units string.
 */
export function shareBps(
  part: string | null | undefined,
  total: string | null | undefined,
): number | null {
  const partMinor = minorToBigInt(part)
  const totalMinor = minorToBigInt(total)
  if (partMinor === null || totalMinor === null || totalMinor === 0n) {
    return null
  }
  return Math.min(10_000, Number((partMinor * 10_000n) / totalMinor))
}

/**
 * Renders an ISO 8601 UTC instant for display (`2026-11-20 04:02 UTC`).
 * Reporting surfaces always disclose in UTC (PRD §10) so watermarks never
 * drift with the viewer's locale.
 */
export function formatInstantUtc(instant: string | null | undefined): string {
  if (!instant) return '—'
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
