/**
 * Setup step 1 — outlet identity (PRD §8.7, FR-11): saves the HQ-issued
 * outlet ID + code and creates the first admin, in one server transaction.
 * Sealed permanently once saved, which is why the step says so up front.
 */

import { useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { Building2 } from 'lucide-react'
import { PasswordField } from '#/components/PasswordField'
import {
  FailureAlert,
  Field,
  GUIDE_LIST,
  HqGuide,
  STEP_INPUT,
  STEP_SECRET_INPUT,
  StepHeading,
  SubmitButton,
  Ui,
  UpNext,
  shownError,
  useFieldValidation,
} from '#/features/setup/SetupParts'
import {
  describeFailure,
  fieldMessagesOf,
  identitySchema,
} from '#/features/setup/setupFlow'
import type { FieldMessages, IdentityForm } from '#/features/setup/setupFlow'

export function IdentityStep({
  headingRef,
  pending,
  saved,
  error,
  onSubmit,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  pending: boolean
  /** The server accepted this step: the form is locked and the button says so. */
  saved: boolean
  error: Error | null
  onSubmit: (values: IdentityForm) => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const validation = useFieldValidation(formRef)
  const [form, setForm] = useState<IdentityForm>({
    outletId: '',
    outletCode: '',
    adminEmail: '',
    adminPassword: '',
  })

  const locked = pending || saved
  const parsed = identitySchema.safeParse(form)
  const failure = error
    ? describeFailure(error, { step: 'identity', outletCode: null })
    : null
  // Client schema first (it has the friendlier wording); the server's own
  // field messages fill whatever the schema let through.
  const rejected: FieldMessages = {
    ...failure?.fields,
    ...(parsed.success ? {} : fieldMessagesOf(parsed.error)),
  }
  const shown = (key: keyof IdentityForm) =>
    shownError(key, rejected, validation)

  function edit(key: keyof IdentityForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    validation.attempt()
    const values = identitySchema.safeParse(form)
    if (!values.success) return
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
        step={1}
        title="Outlet identity"
        description="Save the ID and code HQ issued for this outlet, then create the first admin account for this register. The ID and code can be saved only once, so check them against HQ."
      />

      <HqGuide
        title="Where to find these in HQ"
        icon={<Building2 className="size-4" aria-hidden="true" />}
      >
        <ol className={GUIDE_LIST}>
          <li>
            In the HQ console, open <Ui>Outlets</Ui>.
          </li>
          <li>
            Create the outlet. The panel that appears has a copy button for its{' '}
            <Ui>Outlet ID</Ui> and <Ui>Code</Ui>.
          </li>
          <li>
            Outlet already created? Open it, switch to the <Ui>Settings</Ui> tab
            and click <Ui>Copy Outlet ID</Ui>. Its code is shown above the tabs.
          </li>
        </ol>
      </HqGuide>

      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        <legend className="kicker m-0 mb-3 p-0">From the HQ console</legend>
        <div className="flex flex-col gap-4">
          <Field
            id="setup-outlet-id"
            label="Outlet ID"
            hint="A UUID, e.g. 11111111-1111-4111-8111-111111111111."
            error={shown('outletId')}
          >
            {(input) => (
              <input
                {...input}
                required
                value={form.outletId}
                onChange={(event) =>
                  edit('outletId', event.target.value.trim())
                }
                onBlur={() => validation.blur('outletId')}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={STEP_INPUT}
              />
            )}
          </Field>
          <Field
            id="setup-outlet-code"
            label="Outlet code"
            hint="The short prefix printed on receipts, e.g. A."
            error={shown('outletCode')}
          >
            {(input) => (
              <input
                {...input}
                required
                maxLength={8}
                value={form.outletCode}
                onChange={(event) =>
                  edit('outletCode', event.target.value.toUpperCase())
                }
                onBlur={() => validation.blur('outletCode')}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className={`${STEP_INPUT} w-28`}
              />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        <legend className="kicker m-0 mb-1.5 p-0">First admin account</legend>
        <p className="m-0 mb-4 text-xs text-body">
          A new sign-in for this register — not your HQ console login.
        </p>
        <div className="flex flex-col gap-4">
          <Field
            id="setup-admin-email"
            label="Admin email"
            error={shown('adminEmail')}
          >
            {(input) => (
              <input
                {...input}
                type="email"
                required
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={form.adminEmail}
                onChange={(event) => edit('adminEmail', event.target.value)}
                onBlur={() => validation.blur('adminEmail')}
                placeholder="admin@your-outlet.com"
                className={STEP_INPUT}
              />
            )}
          </Field>
          <Field
            id="setup-admin-password"
            label="Password"
            hint="At least 8 characters."
            error={shown('adminPassword')}
          >
            {(input) => (
              <PasswordField
                {...input}
                revealName="the admin password"
                className={STEP_SECRET_INPUT}
                required
                autoComplete="new-password"
                value={form.adminPassword}
                onChange={(event) => edit('adminPassword', event.target.value)}
                onBlur={() => validation.blur('adminPassword')}
              />
            )}
          </Field>
        </div>
      </fieldset>

      {failure ? <FailureAlert failure={failure} /> : null}

      <div className="flex flex-col gap-3">
        <SubmitButton
          state={saved ? 'saved' : pending ? 'pending' : 'idle'}
          label="Save identity & continue"
          pendingLabel="Saving…"
          savedLabel="Identity saved"
        />
        <UpNext>
          <Ui>Pair with HQ</Ui> — have the one-time key from the HQ console
          ready.
        </UpNext>
      </div>
    </form>
  )
}
