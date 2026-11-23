import { Check } from 'lucide-react'
import { cn } from '#/lib/utils'

export type SetupStepId = 'identity' | 'connection'

/**
 * The wizard's steps, in order. Both are always on screen: the upcoming one
 * says what it will need from the HQ console, so the operator can see what
 * comes after step 1 before saving it. Step 1 is sealed once saved (PRD
 * FR-11), so steps are an indicator only — never links.
 */
const SETUP_STEPS: readonly {
  id: SetupStepId
  title: string
  /** What the step needs from the HQ console. */
  caption: string
  /** The caption once the step is complete. */
  done: string
}[] = [
  {
    id: 'identity',
    title: 'Outlet identity',
    caption: 'Outlet ID + code from HQ',
    done: 'Saved',
  },
  {
    id: 'connection',
    title: 'Pair with HQ',
    caption: 'One-time key from HQ',
    done: 'Paired',
  },
]

type StepState = 'done' | 'current' | 'upcoming'

const CIRCLE: Record<StepState, string> = {
  done: 'border-ink bg-ink text-on-primary',
  current: 'border-ink bg-ink text-on-primary',
  upcoming: 'border-hairline-strong bg-surface-card text-muted-foreground',
}

const LABEL: Record<StepState, string> = {
  done: 'text-body',
  current: 'text-ink',
  upcoming: 'text-muted-foreground',
}

/**
 * Two-step progress indicator. State is carried by the glyph (✓ / number),
 * text colour and the ink connector — never colour alone — and exposed to
 * assistive tech through `aria-current="step"` plus an sr-only
 * "Step n of 2" prefix. Vertical on phones, horizontal from `sm`.
 *
 * When a step completes, its number becomes a check and the connector sweeps
 * on to the next step: the indicator advances the moment the server accepts
 * the step, before the step panel below changes.
 */
export function SetupStepper({
  current,
}: {
  /** The step on screen, `'done'` once both are complete, `null` while the
   * terminal's state is still unknown. */
  current: SetupStepId | 'done' | null
}) {
  const currentIndex = SETUP_STEPS.findIndex((step) => step.id === current)

  return (
    <ol
      aria-label="Setup steps"
      className="m-0 flex list-none flex-col gap-3 p-0 sm:grid sm:grid-cols-2 sm:gap-0"
    >
      {SETUP_STEPS.map((step, index) => {
        const state: StepState =
          current === 'done' || index < currentIndex
            ? 'done'
            : index === currentIndex
              ? 'current'
              : 'upcoming'
        const last = index === SETUP_STEPS.length - 1

        return (
          <li
            key={step.id}
            aria-current={state === 'current' ? 'step' : undefined}
            className="relative flex items-center gap-x-3 sm:flex-col sm:items-start sm:gap-x-0 sm:gap-y-2"
          >
            {last ? null : (
              <>
                {/* Connector to the next step — a hairline track with an ink
                    fill that sweeps along it once this step is done. Vertical
                    on phones, horizontal from `sm`. */}
                <span
                  aria-hidden="true"
                  className="absolute top-8 -bottom-1.5 left-4 w-px sm:hidden"
                >
                  <Connector filled={state === 'done'} axis="y" />
                </span>
                <span
                  aria-hidden="true"
                  className="absolute top-4 right-3 left-11 hidden h-px sm:block"
                >
                  <Connector filled={state === 'done'} axis="x" />
                </span>
              </>
            )}
            <span
              aria-hidden="true"
              className={cn(
                CIRCLE[state],
                'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors duration-300 motion-reduce:transition-none',
              )}
            >
              {state === 'done' ? (
                <Check
                  className="size-4 animate-in zoom-in-75 duration-300 motion-reduce:animate-none"
                  strokeWidth={2.5}
                />
              ) : (
                <span className="text-sm font-semibold tabular-nums">
                  {index + 1}
                </span>
              )}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={cn(LABEL[state], 'text-sm leading-5 font-medium')}
              >
                <span className="sr-only">
                  Step {index + 1} of {SETUP_STEPS.length}
                  {state === 'done'
                    ? ', completed. '
                    : state === 'current'
                      ? ', current step. '
                      : '. '}
                </span>
                {step.title}
              </span>
              <span
                className={cn(
                  'text-xs leading-4',
                  state === 'upcoming' ? 'text-muted-foreground' : 'text-body',
                )}
              >
                {state === 'done' ? step.done : step.caption}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The track and its fill; the fill grows from the step already passed. */
function Connector({ filled, axis }: { filled: boolean; axis: 'x' | 'y' }) {
  return (
    <>
      <span className="absolute inset-0 bg-hairline-strong" />
      <span
        className={cn(
          'absolute inset-0 bg-ink transition-transform duration-500 ease-out motion-reduce:transition-none',
          axis === 'y' ? 'origin-top' : 'origin-left',
          filled ? 'scale-100' : 'scale-0',
        )}
      />
    </>
  )
}
