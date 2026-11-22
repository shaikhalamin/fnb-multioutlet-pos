import * as React from 'react'
import { CheckIcon, MinusIcon } from 'lucide-react'
import { cn } from 'cn'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'

// Editorial checkbox (DESIGN_SYSTEM.md): an 18px box, filled with the ink pill
// colour when checked. The control itself is a 36px transparent button, so the
// hit target clears the WCAG 2.2 minimum without stretching table rows.
// Focus = ink ring drawn on the visible box. The unchecked outline is the
// muted token rather than the input hairline: at 18px the hairline is only
// ~1.5:1 against the card, and a control boundary needs 3:1 (WCAG 1.4.11).
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'group relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors enabled:hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        data-slot="checkbox-box"
        aria-hidden="true"
        className="pointer-events-none flex size-[18px] items-center justify-center rounded-[5px] border border-muted-foreground bg-surface-card transition-colors group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=indeterminate]:border-primary group-data-[state=indeterminate]:bg-primary group-focus-visible:border-ring group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50"
      />
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="absolute flex items-center justify-center text-on-primary"
      >
        {props.checked === 'indeterminate' ? (
          <MinusIcon className="size-3.5" strokeWidth={3} />
        ) : (
          <CheckIcon className="size-3.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
