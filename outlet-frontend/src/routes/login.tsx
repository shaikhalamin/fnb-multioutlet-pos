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
    'The register is temporarily unavailable. Try again shortly.',
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
    // Already signed in (or a live refresh cookie) → straight to the POS.
    if (session.user) {
      void navigate({ to: '/pos', replace: true })
      return
    }
    void refreshSessionNow().then((refreshed) => {
      if (refreshed && sessionStore.get().user) {
        void navigate({ to: '/pos', replace: true })
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
      await navigate({ to: '/pos', replace: true })
    } catch (cause) {
      setError(loginErrorMessage(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="page-wrap py-16">
      <section className="island-shell mx-auto max-w-md rounded-2xl p-8">
        <p className="island-kicker mb-2">Outlet Register</p>
        <h1 className="mb-1 text-2xl font-semibold text-[var(--sea-ink)]">
          Sign in
        </h1>
        <p className="mb-6 mt-1 text-sm text-[var(--sea-ink-soft)]">
          Use your outlet staff account to run the register, manage stock and
          look up receipts.
        </p>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          noValidate
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-2 text-sm font-normal text-[var(--sea-ink)] outline-none focus:border-[#56c6be]"
              placeholder="cashier@outlet-a.local"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-2 text-sm font-normal text-[var(--sea-ink)] outline-none focus:border-[#56c6be]"
              placeholder="••••••••"
            />
          </label>
          {error ? (
            <p
              role="alert"
              className="m-0 rounded-lg bg-[rgba(235,87,87,0.12)] px-3 py-2 text-sm text-[#a03030]"
            >
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(47,143,131,0.28)] transition hover:brightness-105 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}
