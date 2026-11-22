import * as React from 'react'
import { cn } from 'cn'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'

// Editorial radio group (DESIGN_SYSTEM.md): the option row that wraps an item
// is the click target, so the item itself only draws an 18px circle centred in
// a 24px control. Selected = ink ring + ink dot (shape, not colour alone). The
// unselected ring uses the muted token so its boundary keeps 3:1 (WCAG 1.4.11).
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid gap-2', className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'group relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors enabled:hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        data-slot="radio-group-item-ring"
        aria-hidden="true"
        className="pointer-events-none absolute inset-[3px] rounded-full border border-muted-foreground bg-surface-card transition-colors group-data-[state=checked]:border-primary group-focus-visible:border-ring group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50"
      />
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-item-indicator"
        className="relative flex items-center justify-center"
      >
        <span className="size-2 rounded-full bg-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem }
