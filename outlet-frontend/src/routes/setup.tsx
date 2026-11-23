import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '#/api/axios'
import { setupControllerCreateIdentity } from '#/api/generated/clients/setupControllerCreateIdentity'
import { setupControllerGetStatus } from '#/api/generated/clients/setupControllerGetStatus'
import { setupControllerSaveHqConnection } from '#/api/generated/clients/setupControllerSaveHqConnection'
import { setupControllerGetStatusStatus200Schema } from '#/api/generated/schemas/setupControllerGetStatusSchema'
import type { HqConnectionResponse } from '#/api/generated/types/HqConnectionResponse'
import type { SetupIdentityResponse } from '#/api/generated/types/SetupIdentityResponse'
import { setupKeys } from '#/features/setup/keys'
import { ConnectionStep } from '#/features/setup/ConnectionStep'
import { DoneStep } from '#/features/setup/DoneStep'
import { IdentityStep } from '#/features/setup/IdentityStep'
import { Checking, Problem } from '#/features/setup/SetupParts'
import { SetupStepper } from '#/features/setup/SetupStepper'
import { STEP_CHANGE, describeFailure } from '#/features/setup/setupFlow'
import type { ConnectionForm, IdentityForm } from '#/features/setup/setupFlow'
import { cn } from '#/lib/utils'

/**
 * First-run terminal setup wizard (PRD §8.7 bootstrap, §9.2 secure
 * provisioning channel, FR-11): step 1 saves the HQ-issued outlet ID + code
 * and creates the first admin; step 2 pairs with HQ using the one-time key
 * issued in the HQ console. Both steps are public only while this terminal
 * is unprovisioned — the backend seals them permanently afterwards.
 */
export const Route = createFileRoute('/setup')({ component: SetupPage })

/**
 * What the card shows. Derived on every render from the status query plus
 * this session's own progress, so the wizard and the server can never
 * disagree for more than a refetch. `sealed` = already paired when we
 * arrived: nothing left to do here.
 */
type View =
  'checking' | 'unavailable' | 'identity' | 'connection' | 'done' | 'sealed'

/** A wizard step — what the step panel shows. */
type StepView = 'identity' | 'connection' | 'done'

function isStepView(view: View): view is StepView {
  return view === 'identity' || view === 'connection' || view === 'done'
}

/** The panel enters on its own (forward motion from below); leaving, it
 * fades out in place so the swap to the next step is never a hard cut. */
const PANEL_ENTER =
  'animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none'
const PANEL_EXIT =
  'pointer-events-none animate-out fade-out fill-mode-forwards duration-150 ease-in motion-reduce:animate-none'

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Scrolls the card top back under the sticky header, unless it is already in
 * view: the stepper there is what shows that the step changed, and the submit
 * button sits at the bottom of a step that may be taller than the screen.
 */
function revealCard(card: HTMLElement) {
  const { top } = card.getBoundingClientRect()
  const headerBottom =
    document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
  if (top >= headerBottom + 8 && top < window.innerHeight / 2) return
  card.scrollIntoView({
    block: 'start',
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  })
}

function SetupPage() {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: setupKeys.status(),
    // Parse with the generated schema (AGENTS §4.2) — this endpoint carries
    // no money, but a malformed report should surface as an error, not UI.
    queryFn: async () =>
      setupControllerGetStatusStatus200Schema.parse(
        await setupControllerGetStatus(),
      ),
    retry: false,
  })
  const data = status.data

  // Progress made in this session, kept apart from `status`: a success shows
  // at once and stays up. Pairing flips `provisioned`, which must not bounce
  // a freshly paired register to sign-in before it sees the confirmation.
  const [savedIdentity, setSavedIdentity] =
    useState<SetupIdentityResponse | null>(null)
  const [paired, setPaired] = useState<HqConnectionResponse | null>(null)

  const view: View = paired
    ? 'done'
    : data === undefined
      ? status.isError
        ? 'unavailable'
        : 'checking'
      : data.provisioned
        ? 'sealed'
        : data.identity || savedIdentity
          ? 'connection'
          : 'identity'

  // Step-change choreography. A step the server just accepted stays on
  // screen for a beat so its button can confirm the save (the stepper has
  // already advanced), then fades out; only then does the next step fade in.
  // The timers live in effects, so unmounting or a resync clears them.
  const [outgoing, setOutgoing] = useState<StepView | null>(null)
  const [leaving, setLeaving] = useState(false)
  const shown: View = outgoing ?? view

  useEffect(() => {
    if (outgoing === null || leaving) return
    const timer = window.setTimeout(
      () => setLeaving(true),
      STEP_CHANGE.confirmMs,
    )
    return () => window.clearTimeout(timer)
  }, [outgoing, leaving])

  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => {
      setOutgoing(null)
      setLeaving(false)
    }, STEP_CHANGE.exitMs)
    return () => window.clearTimeout(timer)
  }, [leaving])

  // Set when this session caused a step change (a submit or a resync): the
  // new step's heading then takes focus, so keyboard and screen-reader users
  // land on it instead of on a button that is about to unmount. A layout
  // effect: the focus moves in the same commit as the swap, so there is no
  // frame in which it has fallen back to <body>.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const focusHeading = useRef(false)
  const previousShown = useRef(shown)
  useLayoutEffect(() => {
    const changed = previousShown.current !== shown
    previousShown.current = shown
    if (!changed || !focusHeading.current || !isStepView(shown)) return
    focusHeading.current = false
    headingRef.current?.focus({ preventScroll: true })
  }, [shown])

  /** The server is ahead of (or behind) the wizard: let status move it. */
  function resync() {
    focusHeading.current = true
    void queryClient.invalidateQueries({ queryKey: setupKeys.status() })
  }

  /** A step succeeded: confirm it, bring the stepper into view, move on. */
  function advance(step: StepView) {
    setOutgoing(step)
    focusHeading.current = true
    if (cardRef.current) revealCard(cardRef.current)
  }

  const outletCode = savedIdentity?.outletCode ?? data?.outletCode ?? null
  const adminEmail = savedIdentity?.adminEmail ?? null
  const outletId = savedIdentity?.outletId ?? data?.outletId ?? ''

  const createIdentity = useMutation({
    mutationFn: (body: IdentityForm) => setupControllerCreateIdentity({ body }),
    onSuccess: (result) => {
      setSavedIdentity(result)
      advance('identity')
      void queryClient.invalidateQueries({ queryKey: setupKeys.status() })
    },
    onError: (cause) => {
      if (describeFailure(cause, { step: 'identity', outletCode }).resync) {
        resync()
      }
    },
  })

  const saveConnection = useMutation({
    mutationFn: (body: ConnectionForm) =>
      setupControllerSaveHqConnection({ body }),
    onSuccess: (result) => {
      setPaired(result)
      advance('connection')
      void queryClient.invalidateQueries({ queryKey: setupKeys.status() })
    },
    onError: (cause) => {
      if (describeFailure(cause, { step: 'connection', outletCode }).resync) {
        resync()
      }
    },
  })

  if (view === 'sealed') {
    // Already paired: nothing to do here.
    return <Navigate to="/login" replace />
  }

  return (
    <main className="page-wrap py-16">
      <div className="relative mx-auto max-w-xl">
        <span
          aria-hidden="true"
          className="orb orb-lavender -top-14 -left-16 h-56 w-56"
        />
        {/* The card opts out of scroll anchoring — otherwise the browser
            compensates for the swapped step's height right after a step
            change and cancels the scroll. The scroll margin clears the sticky
            header, which wraps to two rows on phones. */}
        <section
          ref={cardRef}
          aria-labelledby="setup-title"
          className="card-panel relative scroll-mt-28 p-6 [overflow-anchor:none] sm:scroll-mt-24 sm:p-8"
        >
          <p className="kicker m-0 mb-2">Terminal setup</p>
          <h1
            id="setup-title"
            className="m-0 mb-1.5 font-display text-display-sm text-ink"
          >
            Set up this register
          </h1>
          <p className="m-0 mb-6 text-sm text-body">
            Two short steps, done once. Keep the HQ console open — each step
            needs values you copy from there.
          </p>

          {/* The stepper follows the server's truth, so it advances the
              moment a step is accepted — before the panel below changes. */}
          <SetupStepper
            current={
              view === 'done'
                ? 'done'
                : view === 'identity' || view === 'connection'
                  ? view
                  : null
            }
          />

          <div
            key={shown}
            aria-busy={outgoing !== null}
            className={cn(
              'mt-6 border-t border-hairline pt-6',
              leaving ? PANEL_EXIT : PANEL_ENTER,
            )}
          >
            {shown === 'checking' ? <Checking /> : null}
            {shown === 'unavailable' ? (
              <Unavailable
                error={status.error}
                onRetry={() => {
                  focusHeading.current = true
                  void status.refetch()
                }}
              />
            ) : null}
            {shown === 'identity' ? (
              <IdentityStep
                headingRef={headingRef}
                pending={createIdentity.isPending}
                saved={outgoing === 'identity'}
                error={createIdentity.error}
                onSubmit={(values) => createIdentity.mutate(values)}
              />
            ) : null}
            {shown === 'connection' ? (
              <ConnectionStep
                headingRef={headingRef}
                pending={saveConnection.isPending}
                saved={outgoing === 'connection'}
                error={saveConnection.error}
                identity={{ outletId, outletCode, adminEmail }}
                onSubmit={(values) => saveConnection.mutate(values)}
              />
            ) : null}
            {shown === 'done' && paired ? (
              <DoneStep
                headingRef={headingRef}
                paired={paired}
                identity={{ outletId, outletCode, adminEmail }}
              />
            ) : null}
          </div>

          {/* Announces the save during the beat — the focused button's own
              label change is not reliably spoken. */}
          <p role="status" aria-live="polite" className="sr-only">
            {outgoing === 'identity'
              ? 'Outlet identity saved. Continuing to step 2.'
              : outgoing === 'connection'
                ? 'Paired with HQ. Setup complete.'
                : null}
          </p>
        </section>
      </div>
    </main>
  )
}

function Unavailable({
  error,
  onRetry,
}: {
  error: Error | null
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Problem
        title="Couldn't check this terminal"
        requestId={error instanceof ApiError ? error.requestId : undefined}
      >
        <p className="m-0 mt-0.5 text-sm text-body">
          This register&apos;s backend didn&apos;t answer, so setup can&apos;t
          tell whether it has been set up already. Check that the outlet backend
          is running, then try again.
        </p>
      </Problem>
      <button type="button" onClick={onRetry} className="btn-primary">
        Try again
      </button>
    </div>
  )
}
