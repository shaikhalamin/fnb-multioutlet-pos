import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { refreshSessionNow } from '#/features/auth/api'
import { useSession } from '#/features/auth/session'

export const Route = createFileRoute('/')({ component: App })

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
