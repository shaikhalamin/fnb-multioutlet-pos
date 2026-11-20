import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ApiError } from '#/api/axios'
import { healthControllerGetHealth } from '#/api/generated/clients/healthControllerGetHealth'
import { healthControllerGetHealthStatus200Schema } from '#/api/generated/schemas/healthControllerGetHealthSchema'

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
      ? 'bg-[rgba(52,199,89,0.15)] text-[#1d7a3f]'
      : status === 'down'
        ? 'bg-[rgba(235,87,87,0.14)] text-[#a03030]'
        : 'bg-[rgba(120,120,120,0.14)] text-[var(--sea-ink-soft)]'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}
    >
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
      <section className="island-shell mt-8 rounded-2xl p-6" aria-busy="true">
        <p className="island-kicker mb-2">Platform Health</p>
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
          Checking backend services…
        </p>
      </section>
    )
  }

  if (health.isError) {
    const error = health.error instanceof ApiError ? health.error : null
    return (
      <section className="island-shell mt-8 rounded-2xl p-6" role="alert">
        <p className="island-kicker mb-2">Platform Health</p>
        <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
          HQ API unreachable <StatusPill status="down" />
        </h2>
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
          {error
            ? `${error.code}: ${error.message}`
            : 'Network request failed.'}
        </p>
      </section>
    )
  }

  const report = health.data
  return (
    <section className="island-shell mt-8 rounded-2xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="island-kicker m-0">Platform Health</p>
        <StatusPill status={report.status === 'ok' ? 'up' : 'down'} />
      </div>
      <dl className="m-0 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Service
          </dt>
          <dd className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
            {report.service} v{report.version}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Database
          </dt>
          <dd className="m-0">
            <StatusPill status={report.checks.database.status} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Redis
          </dt>
          <dd className="m-0">
            <StatusPill status={report.checks.redis.status} />
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Uptime
          </dt>
          <dd className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
            {Math.floor(report.uptimeSeconds / 60)}m {report.uptimeSeconds % 60}
            s
          </dd>
        </div>
      </dl>
      <p className="mt-4 mb-0 text-xs text-[var(--sea-ink-soft)]">
        Checked at {new Date(report.timestamp).toLocaleTimeString()}
      </p>
    </section>
  )
}

function App() {
  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
        <p className="island-kicker mb-3">Multi-Outlet F&amp;B Platform</p>
        <h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          Headquarters console.
        </h1>
        <p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          Master menu governance, outlet assignment, API keys and cross-outlet
          reporting for every outlet site. Phase 0 foundation: signed builds,
          typed contracts and observable services.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="/api/v1/docs"
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
          >
            API Documentation
          </a>
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
            className="island-shell feature-card rise-in rounded-2xl p-5"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
              {title}
            </h2>
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{desc}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
