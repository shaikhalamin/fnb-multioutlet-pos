import type { ReactNode } from 'react'
import { cn } from 'cn'

/**
 * Segmented section tabs (root AGENTS §4.5 token-only styling): a soft track
 * holding one pill per in-page section. Each child is a `<Link>` styled with
 * `sectionTabClass` — tabs are real links, so the section on screen lives in
 * the URL and survives refresh, back and sharing; the active pill carries
 * `aria-current="page"`.
 */
export function SectionTabs({
  label,
  className,
  children,
}: {
  /** Accessible name of the group, rendered as `<nav aria-label>`. */
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'inline-flex max-w-full flex-wrap gap-1 rounded-full border border-hairline bg-surface-strong p-1',
        className,
      )}
    >
      {children}
    </nav>
  )
}

/** Class list for one tab link; pass whether it is the section on screen. */
export function sectionTabClass(active: boolean) {
  return cn(
    // Once the pills wrap (phones), each one fills its row — full-width targets.
    'rounded-full border px-5 py-2.5 text-center text-sm font-medium no-underline whitespace-nowrap max-[480px]:flex-1',
    active
      ? 'border-hairline-strong bg-surface-card text-ink shadow-soft'
      : 'border-transparent text-body hover:bg-canvas-soft hover:text-ink',
  )
}
