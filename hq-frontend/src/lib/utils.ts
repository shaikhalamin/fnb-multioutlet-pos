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
