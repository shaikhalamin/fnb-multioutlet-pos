import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { setupControllerCreateIdentity } from '#/api/generated/clients/setupControllerCreateIdentity'
import { setupControllerGetStatus } from '#/api/generated/clients/setupControllerGetStatus'
import { setupControllerSaveHqConnection } from '#/api/generated/clients/setupControllerSaveHqConnection'
import { setupControllerGetStatusStatus200Schema } from '#/api/generated/schemas/setupControllerGetStatusSchema'
import { setupKeys } from '#/features/setup/keys'

export const Route = createFileRoute('/setup')({ component: SetupPage })

/**
 * First-run terminal setup wizard (PRD §8.7 bootstrap, §9.2 secure
 * provisioning channel): step 1 saves the HQ-issued outlet ID + code and
 * creates the first admin; step 2 pairs with HQ using the one-time key
 * issued in the HQ console. Both steps are public only while this terminal
 * is unprovisioned — the backend seals them permanently afterwards.
 */
const identitySchema = z.object({
  outletId: z
    .string()
    .uuid('Paste the Outlet ID (a UUID) from the HQ console.'),
  outletCode: z
    .string()
    .min(1, 'Outlet code is required.')
    .max(8, 'Outlet code is at most 8 characters.'),
  adminEmail: z.string().email('Enter a valid email for the first admin.'),
  adminPassword: z
    .string()
    .min(8, 'Admin password must be at least 8 characters.'),
})

const connectionSchema = z.object({
  hqApiBaseUrl: z
    .string()
    .url('Enter the HQ base URL, e.g. http://hq-api:3000/api/v1.'),
  keyId: z.string().min(8, 'Paste the key ID shown when HQ issued the key.'),
  keySecret: z.string().min(16, 'Paste the one-time key secret from HQ.'),
})

/** Stable backend error codes (PRD §12) → human-friendly pairing messages. */
const SETUP_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED:
    'HQ rejected this key — check the key ID and the one-time secret (a key for another outlet is refused).',
  SYNC_TEMPORARILY_UNAVAILABLE:
    'HQ is unreachable at that URL. Check the address and that HQ is running.',
  FORBIDDEN: 'This terminal is already provisioned — setup is sealed.',
  CONFLICT: 'Complete the previous setup step first.',
  RATE_LIMITED: 'Too many attempts — wait a moment and try again.',
}

function setupErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const friendly = SETUP_ERROR_MESSAGES[cause.code]
    return friendly ? friendly : `${cause.code}: ${cause.message}`
  }
  return 'Setup failed. Please try again.'
}

function SetupPage() {
  const navigate = useNavigate({ from: '/setup' })
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

  const [step, setStep] = useState<
    'checking' | 'identity' | 'connection' | 'done'
  >('checking')
  const [identityForm, setIdentityForm] = useState({
    outletId: '',
    outletCode: '',
    adminEmail: '',
    adminPassword: '',
  })
  const [connectionForm, setConnectionForm] = useState({
    hqApiBaseUrl: '',
    keyId: '',
    keySecret: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [pairedKeyId, setPairedKeyId] = useState<string | null>(null)

  useEffect(() => {
    if (status.isError) {
      setError('Setup status unavailable — is the outlet backend running?')
      return
    }
    if (!status.data) return
    if (status.data.provisioned) {
      // Already paired: nothing to do here.
      void navigate({ to: '/login', replace: true })
      return
    }
    setStep(status.data.identity ? 'connection' : 'identity')
    // Pre-fill a sensible default base URL for the compose network.
    setConnectionForm((form) => ({
      ...form,
      hqApiBaseUrl: form.hqApiBaseUrl || 'http://hq-api:3000/api/v1',
    }))
  }, [status.data, status.isError, navigate])

  const createIdentity = useMutation({
    mutationFn: (body: z.infer<typeof identitySchema>) =>
      setupControllerCreateIdentity({ body }),
    onSuccess: () => {
      setError(null)
      setStep('connection')
      void queryClient.invalidateQueries({ queryKey: setupKeys.status() })
    },
    onError: (cause) => setError(setupErrorMessage(cause)),
  })

  const saveConnection = useMutation({
    mutationFn: (body: z.infer<typeof connectionSchema>) =>
      setupControllerSaveHqConnection({ body }),
    onSuccess: (response) => {
      setError(null)
      setPairedKeyId(response.keyId)
      setStep('done')
      void queryClient.invalidateQueries({ queryKey: setupKeys.status() })
    },
    onError: (cause) => setError(setupErrorMessage(cause)),
  })

  function handleIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = identitySchema.safeParse(identityForm)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    createIdentity.mutate(parsed.data)
  }

  function handleConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = connectionSchema.safeParse(connectionForm)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.')
      return
    }
    saveConnection.mutate(parsed.data)
  }

  return (
    <main className="page-wrap py-16">
      <div className="relative mx-auto max-w-lg">
        <span
          aria-hidden="true"
          className="orb orb-lavender -top-14 -left-16 h-56 w-56"
        />
        <section className="card-panel relative p-8">
          <p className="kicker mb-2">Terminal Setup</p>
          <h1 className="mb-1 font-display text-display-sm text-ink">
            Pair this register
          </h1>
          <p className="mb-6 mt-1 text-sm text-body">
            Two steps: save the outlet identity created in the HQ console, then
            paste the HQ machine key to start syncing the menu and uploading
            sales.
          </p>

          <ol className="mb-6 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {(['identity', 'connection'] as const).map((label, index) => {
              const active =
                step === label ||
                step === 'done' ||
                (step === 'connection' && label === 'identity')
              return (
                <li
                  key={label}
                  className={`badge-pill ${active ? 'text-ink' : ''}`}
                  aria-current={step === label ? 'step' : undefined}
                >
                  {index + 1}. {label === 'identity' ? 'Identity' : 'Pair HQ'}
                </li>
              )
            })}
          </ol>

          {step === 'checking' ? (
            <p className="m-0 text-sm text-body" aria-busy="true">
              Checking this terminal…
            </p>
          ) : null}

          {step === 'identity' ? (
            <form
              onSubmit={handleIdentity}
              className="flex flex-col gap-4"
              noValidate
            >
              <p className="m-0 text-xs text-body">
                In HQ:{' '}
                <span className="font-medium">Outlets → create the outlet</span>
                , then copy its <span className="font-medium">Outlet ID</span>{' '}
                and <span className="font-medium">code</span> here.
              </p>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                Outlet ID
                <input
                  required
                  value={identityForm.outletId}
                  onChange={(event) =>
                    setIdentityForm({
                      ...identityForm,
                      outletId: event.target.value.trim(),
                    })
                  }
                  className="text-input font-normal"
                  placeholder="11111111-1111-4111-8111-111111111111"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                Outlet code (receipt prefix)
                <input
                  required
                  maxLength={8}
                  value={identityForm.outletCode}
                  onChange={(event) =>
                    setIdentityForm({
                      ...identityForm,
                      outletCode: event.target.value.toUpperCase(),
                    })
                  }
                  className="text-input font-normal"
                  placeholder="A"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                First admin email
                <input
                  type="email"
                  required
                  autoComplete="username"
                  value={identityForm.adminEmail}
                  onChange={(event) =>
                    setIdentityForm({
                      ...identityForm,
                      adminEmail: event.target.value,
                    })
                  }
                  className="text-input font-normal"
                  placeholder="admin@outlet-a.local"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                First admin password
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={identityForm.adminPassword}
                  onChange={(event) =>
                    setIdentityForm({
                      ...identityForm,
                      adminPassword: event.target.value,
                    })
                  }
                  className="text-input font-normal"
                  placeholder="At least 8 characters"
                />
              </label>
              {error ? (
                <p
                  role="alert"
                  className="m-0 rounded-lg bg-error/10 px-3 py-2 text-sm text-error"
                >
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={createIdentity.isPending}
                className="btn-primary mt-2"
              >
                {createIdentity.isPending
                  ? 'Saving identity…'
                  : 'Save identity'}
              </button>
            </form>
          ) : null}

          {step === 'connection' ? (
            <form
              onSubmit={handleConnection}
              className="flex flex-col gap-4"
              noValidate
            >
              <p className="m-0 text-xs text-body">
                In HQ: open this outlet’s page →{' '}
                <span className="font-medium">API keys → Issue key</span>, copy
                the one-time <span className="font-medium">key ID</span> and{' '}
                <span className="font-medium">secret</span>, then pair below. HQ
                checks the key live before anything is saved.
              </p>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                HQ base URL
                <input
                  required
                  value={connectionForm.hqApiBaseUrl}
                  onChange={(event) =>
                    setConnectionForm({
                      ...connectionForm,
                      hqApiBaseUrl: event.target.value.trim(),
                    })
                  }
                  className="text-input font-normal"
                  placeholder="http://hq-api:3000/api/v1"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                Key ID
                <input
                  required
                  value={connectionForm.keyId}
                  onChange={(event) =>
                    setConnectionForm({
                      ...connectionForm,
                      keyId: event.target.value.trim(),
                    })
                  }
                  className="text-input font-normal"
                  placeholder="ok_dev_…"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
                Key secret (shown once by HQ)
                <input
                  type="password"
                  required
                  autoComplete="off"
                  value={connectionForm.keySecret}
                  onChange={(event) =>
                    setConnectionForm({
                      ...connectionForm,
                      keySecret: event.target.value.trim(),
                    })
                  }
                  className="text-input font-normal"
                  placeholder="one-time secret"
                />
              </label>
              {error ? (
                <p
                  role="alert"
                  className="m-0 rounded-lg bg-error/10 px-3 py-2 text-sm text-error"
                >
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={saveConnection.isPending}
                className="btn-primary mt-2"
              >
                {saveConnection.isPending
                  ? 'Validating with HQ…'
                  : 'Test & pair'}
              </button>
            </form>
          ) : null}

          {step === 'done' ? (
            <div className="flex flex-col gap-4">
              <p className="m-0 rounded-lg bg-success/10 px-3 py-3 text-sm text-success">
                Paired with HQ (key <span className="money">{pairedKeyId}</span>
                ). The menu syncs automatically within a minute — stock items
                via Inventory, then start selling.
              </p>
              <Link
                to="/login"
                className="btn-primary no-underline text-center"
              >
                Sign in with the admin account
              </Link>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  )
}
