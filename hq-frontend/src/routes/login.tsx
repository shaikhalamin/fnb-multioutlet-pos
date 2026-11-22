import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { login, refreshSessionNow } from '#/features/auth/api'
import { sessionStore, useSession } from '#/features/auth/session'

export const Route = createFileRoute('/login')({ component: LoginPage })

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
})

/** Stable backend error codes (PRD §12) → human-friendly sign-in messages. */
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Incorrect email or password.',
  RATE_LIMITED: 'Too many attempts — wait a moment and try again.',
  VALIDATION_FAILED: 'Please check the email and password format.',
  SERVICE_UNAVAILABLE:
    'The service is temporarily unavailable. Try again shortly.',
}

function loginErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const friendly = LOGIN_ERROR_MESSAGES[cause.code]
    return friendly
      ? `${friendly}${cause.requestId ? ` (request ${cause.requestId})` : ''}`
      : `${cause.message}${cause.requestId ? ` (request ${cause.requestId})` : ''}`
  }
  return 'Sign-in failed. Please try again.'
}

function LoginPage() {
  const navigate = useNavigate({ from: '/login' })
  const session = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    // Already signed in (or a live refresh cookie) → straight to the console.
    if (session.user) {
      void navigate({ to: '/dashboard', replace: true })
      return
    }
    void refreshSessionNow().then((refreshed) => {
      if (refreshed && sessionStore.get().user) {
        void navigate({ to: '/dashboard', replace: true })
      }
    })
  }, [session.user, navigate])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const parsed = credentialsSchema.safeParse({ email, password })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid credentials.')
      return
    }
    setSubmitting(true)
    try {
      await login(parsed.data.email, parsed.data.password)
      await navigate({ to: '/dashboard', replace: true })
    } catch (cause) {
      setError(loginErrorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="page-wrap py-16">
      <div className="relative mx-auto max-w-md">
        <span
          aria-hidden="true"
          className="orb orb-lavender -top-12 -right-16 h-56 w-56"
        />
        <section className="card-panel relative p-8">
          <p className="kicker mb-2">F&amp;B Headquarters</p>
          <h1 className="mb-1 font-display text-display-sm text-ink">
            Sign in
          </h1>
          <p className="mb-6 mt-1 text-sm text-body">
            Use your HQ staff account to manage the master menu, outlets and
            keys.
          </p>
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
            noValidate
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              Email
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="form-input font-normal"
                placeholder="admin@fnb.local"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="form-input font-normal"
                placeholder="••••••••"
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
              disabled={submitting}
              className="btn-primary mt-2"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </section>
      </div>
    </main>
  )
}
