/**
 * Setup step 2 — pair with HQ (PRD §8.7, §9.2, FR-11): pastes the one-time HQ
 * machine key, which the backend validates live before saving the pairing.
 * The secret lives only in this component's state for the one request and is
 * cleared with the step when pairing succeeds — never stored or re-shown.
 */

import { useEffect, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { ChevronDown, KeyRound } from 'lucide-react'
import { PasswordField } from '#/components/PasswordField'
import {
  FailureAlert,
  Field,
  GuideNote,
  HqGuide,
  STEP_INPUT,
  STEP_SECRET_INPUT,
  SavedIdentity,
  StepHeading,
  SubmitButton,
  Ui,
  shownError,
  useFieldValidation,
} from '#/features/setup/SetupParts'
import type { IdentitySummary } from '#/features/setup/SetupParts'
import {
  DEFAULT_HQ_API_BASE_URL,
  connectionSchema,
  describeFailure,
  fieldMessagesOf,
  splitConnectionKey,
} from '#/features/setup/setupFlow'
import type { ConnectionForm, FieldMessages } from '#/features/setup/setupFlow'

export function ConnectionStep({
  headingRef,
  pending,
  saved,
  error,
  identity,
  onSubmit,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  pending: boolean
  /** The server accepted this step: the form is locked and the button says so. */
  saved: boolean
  error: Error | null
  identity: IdentitySummary
  onSubmit: (values: ConnectionForm) => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const validation = useFieldValidation(formRef)
  const [form, setForm] = useState<ConnectionForm>({
    hqApiBaseUrl: DEFAULT_HQ_API_BASE_URL,
    keyId: '',
    keySecret: '',
  })
  const [addressOpen, setAddressOpen] = useState(false)
  const { outletCode } = identity
  const outletLabel = outletCode ? `Outlet ${outletCode}` : 'this outlet'

  const locked = pending || saved
  const parsed = connectionSchema.safeParse(form)
  const failure = error
    ? describeFailure(error, { step: 'connection', outletCode })
    : null
  const rejected: FieldMessages = {
    ...failure?.fields,
    ...(parsed.success ? {} : fieldMessagesOf(parsed.error)),
  }
  const shown = (key: keyof ConnectionForm) =>
    shownError(key, rejected, validation)

  // "HQ can't be reached": the address is the usual cause — open the field.
  useEffect(() => {
    const showAddress = error
      ? describeFailure(error, { step: 'connection', outletCode }).showHqAddress
      : false
    if (showAddress) setAddressOpen(true)
  }, [error, outletCode])

  function edit(key: keyof ConnectionForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    validation.attempt()
    // A combined key can reach a field without a paste event (dropped in, or
    // typed): split it here so HQ always receives the two separate values.
    const values = connectionSchema.safeParse(splitConnectionKey(form))
    if (!values.success) return
    setForm((current) => splitConnectionKey(current))
    onSubmit(values.data)
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-6"
    >
      <StepHeading
        ref={headingRef}
        step={2}
        title="Pair with HQ"
        description="Paste the one-time key HQ issued for this outlet. HQ checks it live — nothing is saved unless HQ accepts it."
      />

      <SavedIdentity identity={identity} />

      {/* Labels match the HQ console exactly (hq-frontend outlets.$outletId):
          nav "Outlets" → the outlet's page → the "Settings" tab → the
          "Outlet sync keys" panel → its "Issue new key" button. */}
      <HqGuide
        title="Where to get the key in HQ"
        icon={<KeyRound className="size-4" aria-hidden="true" />}
        trail={[
          'Outlets',
          outletLabel,
          'Settings',
          'Outlet sync keys',
          'Issue new key',
        ]}
      >
        <p className="m-0 text-sm text-body">
          HQ then shows a one-time card. Use its <Ui>Copy key ID</Ui> and{' '}
          <Ui>Copy secret</Ui> buttons — one for each field below.
        </p>
        <GuideNote>
          The secret is shown only once; if it is lost, issue a new key. Can’t
          see <Ui>Outlet sync keys</Ui>? Only HQ users allowed to manage keys
          can issue one — ask your HQ admin.
        </GuideNote>
      </HqGuide>

      <div className="flex flex-col gap-4">
        <Field
          id="setup-key-id"
          label="Key ID"
          hint="From the one-time card in HQ: click “Copy key ID”, then paste here."
          error={shown('keyId')}
        >
          {(input) => (
            <input
              {...input}
              required
              disabled={locked}
              value={form.keyId}
              onChange={(event) => edit('keyId', event.target.value.trim())}
              onBlur={() => validation.blur('keyId')}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ok_dev_…"
              className={STEP_INPUT}
            />
          )}
        </Field>

        <Field
          id="setup-key-secret"
          label="Key secret"
          hint="From the same card: click “Copy secret”, then paste here."
          error={shown('keySecret')}
        >
          {(input) => (
            <PasswordField
              {...input}
              revealName="the key secret"
              className={STEP_SECRET_INPUT}
              required
              disabled={locked}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={form.keySecret}
              onChange={(event) => edit('keySecret', event.target.value.trim())}
              onBlur={() => validation.blur('keySecret')}
            />
          )}
        </Field>
      </div>

      {failure ? <FailureAlert failure={failure} /> : null}

      <div className="flex flex-col gap-2">
        <details
          open={addressOpen}
          onToggle={(event) => setAddressOpen(event.currentTarget.open)}
          className="group rounded-xl border border-hairline"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2.5 hover:bg-canvas-soft [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm leading-5 font-medium text-ink">
                HQ address
              </span>
              <span className="money truncate text-xs text-body">
                {form.hqApiBaseUrl || 'Not set'}
              </span>
            </span>
            <ChevronDown
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <div className="border-t border-hairline-soft px-4 pt-3 pb-4">
            <Field
              id="setup-hq-address"
              label="HQ API URL"
              hint="The address this register's backend reaches HQ at. It ends in /api/v1."
              error={shown('hqApiBaseUrl')}
            >
              {(input) => (
                <input
                  {...input}
                  required
                  disabled={locked}
                  value={form.hqApiBaseUrl}
                  onChange={(event) =>
                    edit('hqApiBaseUrl', event.target.value.trim())
                  }
                  onBlur={() => validation.blur('hqApiBaseUrl')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="http://hq-api:3000/api/v1"
                  className={STEP_INPUT}
                />
              )}
            </Field>
          </div>
        </details>
        <p className="m-0 text-xs leading-5 text-body">
          Pre-filled for the bundled Docker Compose stack. If HQ is deployed
          separately, open this and enter its API URL.
        </p>
      </div>

      <SubmitButton
        state={saved ? 'saved' : pending ? 'pending' : 'idle'}
        label="Test & pair"
        pendingLabel="Checking with HQ…"
        savedLabel="Paired with HQ"
      />
    </form>
  )
}
