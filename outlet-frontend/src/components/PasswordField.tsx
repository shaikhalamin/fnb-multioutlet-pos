import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '#/lib/utils'

/**
 * Password input with a show/hide toggle. Pasting is never blocked and the
 * value lives in the caller's state exactly like a plain input — the toggle
 * only flips the input type, so an operator can check what was pasted.
 * `revealName` names the secret for the toggle's accessible label.
 */
export function PasswordField({
  revealName,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & { revealName: string }) {
  const [revealed, setRevealed] = React.useState(false)

  return (
    <div className="relative">
      <input
        {...props}
        type={revealed ? 'text' : 'password'}
        className={cn('form-input pr-12 font-normal', className)}
      />
      <button
        type="button"
        onClick={() => setRevealed((shown) => !shown)}
        aria-label={`${revealed ? 'Hide' : 'Show'} ${revealName}`}
        aria-pressed={revealed}
        className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {revealed ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
