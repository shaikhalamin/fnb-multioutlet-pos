import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ApiError } from '#/api/axios'
import { healthControllerGetHealth } from '#/api/generated/clients/healthControllerGetHealth'
import { healthControllerGetHealthStatus200Schema } from '#/api/generated/schemas/healthControllerGetHealthSchema'
import { refreshSessionNow } from '#/features/auth/api'
import { useSession } from '#/features/auth/session'

export const Route = createFileRoute('/')({ component: App })

function useHealth() {
  return useQuery({
    queryKey: ['health'],
    // Parse with the generated Zod schema (AGENTS §4.2) so the payload is
    // validated at runtime and typed for render.
    queryFn: async () =>
      healthControllerGetHealthStatus200Schema.parse(
        await healthControllerGetHealth(),
      ),
    refetchInterval: 30_000,
  })
}

function StatusPill({ status }: { status: 'up' | 'down' | 'unknown' }) {
  const tone =
    status === 'up'
      ? 'badge-success'
      : status === 'down'
        ? 'badge-error'
        : 'badge-neutral'
  return (
    <span className={`badge-pill ${tone}`}>
      <span
        className="h-1.5 w-1.5 rounded-full bg-current"
        aria-hidden="true"
      />
      {status.toUpperCase()}
    </span>
  )
}

function HealthPanel() {
  const health = useHealth()

  if (health.isPending) {
    return (
      <section className="card-panel mt-8 p-6" aria-busy="true">
        <p className="kicker mb-2">Platform Health</p>
        <p className="m-0 text-sm text-body">Checking backend services…</p>
      </section>
    )
  }

  if (health.isError) {
    const error = health.error instanceof ApiError ? health.error : null
    return (
      <section className="card-panel mt-8 p-6" role="alert">
        <p className="kicker mb-2">Platform Health</p>
        <h2 className="mb-2 flex flex-wrap items-center gap-2 font-display text-title-md text-ink">
          HQ API unreachable <StatusPill status="down" />
        </h2>
        <p className="m-0 text-sm text-body">
          {error
            ? `${error.code}: ${error.message}`
            : 'Network request failed.'}
        </p>
      </section>
    )
  }

  const report = health.data
  return (
    <section className="card-panel mt-8 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="kicker m-0">Platform Health</p>
        <StatusPill status={report.status === 'ok' ? 'up' : 'down'} />
      </div>
      <dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="kicker mb-1">Service</dt>
          <dd className="m-0 text-sm font-medium text-ink">
            {report.service} v{report.version}
          </dd>
        </div>
        <div>
          <dt className="kicker mb-1">Database</dt>
          <dd className="m-0">
            <StatusPill status={report.checks.database.status} />
          </dd>
        </div>
        <div>
          <dt className="kicker mb-1">Redis</dt>
          <dd className="m-0">
            <StatusPill status={report.checks.redis.status} />
          </dd>
        </div>
        <div>
          <dt className="kicker mb-1">Uptime</dt>
          <dd className="m-0 text-sm font-medium text-ink">
            {Math.floor(report.uptimeSeconds / 60)}m {report.uptimeSeconds % 60}
            s
          </dd>
        </div>
      </dl>
      <p className="mt-4 mb-0 text-xs text-muted-foreground">
        Checked at {new Date(report.timestamp).toLocaleTimeString()}
      </p>
    </section>
  )
}

function App() {
  const session = useSession()
  const user = session.user

  useEffect(() => {
    // The landing page is public, so the `_auth` layout never restores the
    // session here — without this a signed-in visitor (live refresh cookie)
    // would still see the signed-out header and hero CTA.
    if (!user) void refreshSessionNow()
  }, [user])

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="rise-in relative overflow-hidden py-10 sm:py-16">
        <span
          aria-hidden="true"
          className="orb orb-mint -left-24 -top-16 h-72 w-72"
        />
        <span
          aria-hidden="true"
          className="orb orb-peach -right-28 top-8 h-80 w-80"
        />
        {/* Landing moment: centered display copy between the corner orbs
            (DESIGN_SYSTEM §5 — landing/brand copy is centered, not edge-hugging). */}
        <div className="relative flex flex-col items-center text-center">
          <p className="kicker mb-4">Multi-Outlet F&amp;B Platform</p>
          <h1 className="mb-6 max-w-3xl font-display text-display-md text-ink sm:text-display-xl lg:text-display-mega">
            Headquarters console.
          </h1>
          <p className="mb-8 max-w-2xl text-body-md text-body sm:text-lg sm:leading-relaxed">
            Master menu governance, outlet assignment, API keys and cross-outlet
            reporting for every outlet site. Phase 0 foundation: signed builds,
            typed contracts and observable services.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {user ? (
              <Link to="/dashboard" className="btn-primary no-underline">
                Open dashboard
              </Link>
            ) : (
              <Link to="/login" className="btn-primary no-underline">
                Sign in
              </Link>
            )}
            <a href="/api/v1/docs" className="btn-outline no-underline">
              API Documentation
            </a>
          </div>
        </div>
      </section>

      <HealthPanel />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            'Menu Governance',
            'Master catalog with per-outlet assignment and price overrides.',
          ],
          [
            'Outlet Isolation',
            'Every outlet runs its own database, queue and sync worker.',
          ],
          [
            'Typed Contracts',
            'OpenAPI-first APIs with generated frontend clients.',
          ],
          [
            'Observable',
            'Structured JSON logs, request IDs and health probes everywhere.',
          ],
        ].map(([title, desc], index) => (
          <article
            key={title}
            className="feature-card rise-in p-5"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="mb-2 font-display text-title-md text-ink">
              {title}
            </h2>
            <p className="m-0 text-sm text-body">{desc}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
