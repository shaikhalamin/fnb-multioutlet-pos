/**
 * Pieces shared by the steps of the first-run setup wizard (PRD §8.7,
 * FR-11), composed from design-system utilities only (DESIGN_SYSTEM.md §5) —
 * no component class is added to `src/styles.css`.
 */

import { useEffect, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react'
import { cn } from '#/lib/utils'
import type { FieldMessages, SetupFailure } from '#/features/setup/setupFlow'

/** What step 1 saved — carried onto step 2 and the confirmation. */
export type IdentitySummary = {
  outletId: string
  outletCode: string | null
  adminEmail: string | null
}

/**
 * The wizard's fields. A step locks its own while its request runs and once
 * the server has accepted it: nothing typed then would be saved.
 */
export const STEP_INPUT = cn(
  'form-input font-normal',
  'aria-invalid:border-error disabled:cursor-default disabled:bg-canvas-soft',
)

/** PasswordField adds `.form-input` itself; this is the rest. */
export const STEP_SECRET_INPUT = cn(
  'aria-invalid:border-error disabled:cursor-default disabled:bg-canvas-soft',
)

export function Checking() {
  return (
    <p
      role="status"
      aria-busy="true"
      className="m-0 flex items-center gap-2 text-sm text-body"
    >
      <LoaderCircle
        className="size-4 shrink-0 animate-spin"
        aria-hidden="true"
      />
      Checking this terminal…
    </p>
  )
}

/** The heading a step change moves focus to. */
export function StepHeading({
  ref,
  step,
  title,
  description,
}: {
  ref: RefObject<HTMLHeadingElement | null>
  step: 1 | 2
  title: string
  description: string
}) {
  return (
    <div>
      <p className="kicker m-0 mb-1.5">Step {step} of 2</p>
      <h2
        ref={ref}
        tabIndex={-1}
        className="m-0 font-display text-title-md text-ink"
      >
        {title}
      </h2>
      <p className="m-0 mt-1.5 text-sm text-body">{description}</p>
    </div>
  )
}

/** What step 1 saved — which outlet the operator must open in HQ. */
export function SavedIdentity({ identity }: { identity: IdentitySummary }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-success/10 px-4 py-3">
      <Check
        className="mt-0.5 size-4 shrink-0 text-success"
        strokeWidth={2.5}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="m-0 text-sm leading-5 font-medium text-ink">
          Outlet identity saved
        </p>
        <p className="m-0 mt-0.5 text-sm text-body">
          Outlet <Ui>{identity.outletCode ?? '—'}</Ui>
          {identity.adminEmail ? (
            <>
              {' · '}
              Admin <Ui>{identity.adminEmail}</Ui>
            </>
          ) : null}
        </p>
        {/* body, not muted: the muted grey is under 4.5:1 on the green tint */}
        <p className="money m-0 text-xs leading-5 text-body">
          {identity.outletId}
        </p>
      </div>
    </div>
  )
}

/**
 * The walkthrough for the current step in the HQ console: the click path —
 * spelled exactly as the console labels it — followed by whatever else the
 * operator needs before filling the fields.
 */
export function HqGuide({
  title,
  icon,
  trail,
  children,
}: {
  title: string
  icon?: ReactNode
  /** The click path in the HQ console, one label per stop. */
  trail?: readonly string[]
  children: ReactNode
}) {
  return (
    <aside
      aria-label={title}
      className="rounded-xl border border-hairline-soft bg-canvas-soft px-4 py-3.5"
    >
      <p className="kicker m-0 mb-3 flex items-center gap-2">
        {icon ? (
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-strong text-ink"
          >
            {icon}
          </span>
        ) : null}
        {title}
      </p>
      {trail ? (
        <ol
          aria-label="Where to click in HQ"
          className="m-0 mb-3 flex list-none flex-wrap items-center gap-x-1.5 gap-y-2 p-0"
        >
          {trail.map((label, index) => (
            // The arrow trails its label, never leads the next one: a chip
            // and its arrow wrap as one unit, so no line starts with "›".
            <li key={label} className="flex items-center gap-1.5">
              <span className="rounded-full border border-hairline-strong bg-surface-card px-2.5 py-1 text-xs leading-4 font-medium text-ink">
                {label}
              </span>
              {index < trail.length - 1 ? (
                <ChevronRight
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {children}
    </aside>
  )
}

/** A label exactly as the HQ console shows it. */
export function Ui({ children }: { children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>
}

export const GUIDE_LIST =
  'm-0 list-decimal space-y-1.5 pl-4 text-sm text-body marker:text-muted-foreground'

/** The note under a guide's list: what can go wrong, and what to do then. */
export function GuideNote({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-2.5 text-xs leading-5 text-body">{children}</p>
}

export function SubmitButton({
  state,
  label,
  pendingLabel,
  savedLabel,
}: {
  /** `idle` is clickable; `pending` is the request in flight; `saved` is the
   * server's acceptance, shown before the next step replaces this one. */
  state: 'idle' | 'pending' | 'saved'
  label: string
  pendingLabel: string
  savedLabel: string
}) {
  // `aria-disabled`, not `disabled`: the button keeps focus through the
  // request, so a keyboard operator is not dropped on <body> mid-step.
  const locked = state !== 'idle'
  return (
    <button
      type="submit"
      aria-disabled={locked}
      aria-busy={state === 'pending'}
      className={cn(
        'btn-primary',
        state === 'pending' && 'cursor-not-allowed opacity-55',
      )}
    >
      {state === 'pending' ? (
        <>
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : state === 'saved' ? (
        <>
          <Check
            className="size-4 animate-in zoom-in-75 duration-300 motion-reduce:animate-none"
            strokeWidth={2.5}
            aria-hidden="true"
          />
          {savedLabel}
        </>
      ) : (
        <>
          {label}
          <ArrowRight className="size-4" aria-hidden="true" />
        </>
      )}
    </button>
  )
}

/** What happens after the step's button — so the next step is no surprise. */
export function UpNext({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-xs leading-5 text-body">
      <ArrowRight
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span>
        <span className="font-medium text-ink">Up next:</span> {children}
      </span>
    </p>
  )
}

export function FailureAlert({ failure }: { failure: SetupFailure }) {
  return (
    <Problem title={failure.title} requestId={failure.requestId}>
      <p className="m-0 mt-0.5 text-sm text-body">{failure.fix}</p>
    </Problem>
  )
}

/**
 * Something went wrong. The message stays in ink on the tint — red text on a
 * red tint misses 4.5:1 — and the icon carries the error colour.
 */
export function Problem({
  title,
  requestId,
  children,
}: {
  title: string
  requestId?: string
  children: ReactNode
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl bg-error/10 px-4 py-3"
    >
      <CircleAlert
        className="mt-0.5 size-4 shrink-0 text-error"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="m-0 text-sm font-medium text-ink">{title}</p>
        {children}
        {/* body, not muted: muted grey on the red tint is only 3.85:1 */}
        {requestId ? (
          <p className="m-0 mt-1.5 text-xs text-body">
            Request ID <span className="money">{requestId}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Label + control + hint/error, wired for assistive tech. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  /** Renders the control with the id and ARIA wiring it must carry. */
  children: (input: {
    id: string
    'aria-invalid': boolean
    'aria-describedby'?: string
  }) => ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm leading-5 font-medium text-ink">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        'aria-describedby':
          error !== undefined ? `${id}-error` : hint ? `${id}-hint` : undefined,
      })}
      {error !== undefined ? (
        <p
          id={`${id}-error`}
          className="m-0 flex items-start gap-1.5 text-sm text-error"
        >
          <CircleAlert
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="m-0 text-xs leading-5 text-body">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export type FieldFlags = Partial<Record<string, boolean>>

/**
 * Field-level validation for one wizard step: a message appears on blur or on
 * submit — never mid-keystroke — and a submit that leaves invalid fields
 * moves focus to the first of them.
 */
export function useFieldValidation(formRef: RefObject<HTMLFormElement | null>) {
  const [touched, setTouched] = useState<FieldFlags>({})
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (attempts === 0) return
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus()
  }, [attempts, formRef])

  return {
    submitted: attempts > 0,
    touched,
    blur: (key: string) =>
      setTouched((current) =>
        current[key] ? current : { ...current, [key]: true },
      ),
    attempt: () => setAttempts((count) => count + 1),
  }
}

/**
 * The message shown under a field: why it was rejected, but only once the
 * field was touched or the form was submitted (never mid-keystroke).
 */
export function shownError(
  key: string,
  messages: FieldMessages,
  validation: { submitted: boolean; touched: FieldFlags },
) {
  return validation.submitted || validation.touched[key]
    ? messages[key]
    : undefined
}
