import { useState } from 'react'
import type { ReactNode } from 'react'
import { copyText } from '#/lib/clipboard'
import { toastCopied, toastError } from './Toaster'

/**
 * Copy affordances with visible confirmation (root AGENTS §4.5 token-only
 * styling). Every copy raises a toast so a silent clipboard failure on a
 * non-secure origin can never masquerade as success — the button label
 * flips back and an error toast tells the operator to select manually.
 */
export function useCopyAction(label: string) {
  const [copied, setCopied] = useState(false)

  async function copy(value: string): Promise<void> {
    if (await copyText(value)) {
      setCopied(true)
      toastCopied(label)
      window.setTimeout(() => setCopied(false), 2000)
    } else {
      toastError(
        `Could not copy the ${label.toLowerCase()} — select the value and copy manually.`,
      )
    }
  }

  return { copied, copy }
}

/**
 * Labeled read-only value with its own copy button — the shape used for the
 * provisioning values (Outlet ID, key ID, one-time secret) that operators
 * transcribe into the terminal's setup wizard.
 */
export function CopyValue({
  label,
  value,
  children,
  buttonLabel,
  buttonClass = 'btn-outline btn-sm',
}: {
  label: string
  value: string
  /** Optional custom value display; defaults to the raw value in a code block. */
  children?: ReactNode
  buttonLabel?: string
  buttonClass?: string
}) {
  const { copied, copy } = useCopyAction(label)

  return (
    // Label on its own full-width row; the copy button then sits on the value
    // row, vertically centered against the code box it copies — never floating
    // between the label and the value.
    <div>
      <p className="kicker m-0 mb-1.5">{label}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {children ?? (
            <code className="money block break-all rounded-lg border border-hairline bg-canvas-soft px-3 py-2 text-xs text-ink">
              {value}
            </code>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copy(value)}
          className={buttonClass}
          title={`Copy the ${label.toLowerCase()}`}
        >
          {copied ? 'Copied ✓' : (buttonLabel ?? 'Copy')}
        </button>
      </div>
    </div>
  )
}
