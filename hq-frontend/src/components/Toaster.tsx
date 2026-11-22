import { useEffect, useState } from 'react'

/**
 * Minimal toast notifications (copy confirmations and similar non-blocking
 * feedback), styled purely from design-system token utilities (§4.5 — no
 * hardcoded colors). Module-level pub/sub so any component can raise a toast
 * without prop drilling; `<Toaster />` is mounted once in the root layout.
 */

type Toast = { id: number; message: string; tone: 'success' | 'error' }

type Listener = (toast: Toast) => void

const listeners = new Set<Listener>()
let nextId = 1

function publish(message: string, tone: Toast['tone']): void {
  const toast: Toast = { id: nextId++, message, tone }
  for (const listener of listeners) listener(toast)
}

/** Confirm a copy succeeded — the user asked for visible proof (AGENTS §4.5). */
export function toastCopied(label: string): void {
  publish(`${label} copied to clipboard`, 'success')
}

export function toastError(message: string): void {
  publish(message, 'error')
}

function useToasts(): Toast[] {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const listener: Listener = (toast) => {
      setToasts((current) => [...current, toast])
      window.setTimeout(() => {
        setToasts((current) => current.filter((entry) => entry.id !== toast.id))
      }, 2800)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return toasts
}

export function Toaster() {
  const toasts = useToasts()

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4"
    >
      {toasts.map((toast) => (
        <p
          key={toast.id}
          role="status"
          className={`m-0 w-full rounded-xl border px-4 py-2.5 text-center text-sm font-medium ${
            toast.tone === 'success'
              ? 'border-hairline bg-surface-card text-success'
              : 'border-hairline bg-surface-card text-error'
          }`}
        >
          {toast.message}
        </p>
      ))}
    </div>
  )
}
