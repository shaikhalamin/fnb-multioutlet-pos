import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { setupControllerGetStatus } from '#/api/generated/clients/setupControllerGetStatus'
import { setupControllerGetStatusStatus200Schema } from '#/api/generated/schemas/setupControllerGetStatusSchema'
import { setupKeys } from '#/features/setup/keys'
import { useSession } from '#/features/auth/session'

export const Route = createFileRoute('/')({ component: App })

/** Provisioning probe: drives the "set up this terminal" CTA before pairing. */
function useSetupStatus() {
  return useQuery({
    queryKey: setupKeys.status(),
    queryFn: async () =>
      setupControllerGetStatusStatus200Schema.parse(
        await setupControllerGetStatus(),
      ),
    retry: false,
    refetchOnWindowFocus: false,
  })
}

function SetupCard({ unprovisioned }: { unprovisioned: boolean }) {
  if (!unprovisioned) return null
  return (
    <section className="card-panel mt-8 flex flex-wrap items-center justify-between gap-4 border-hairline p-6">
      <div>
        <p className="kicker mb-1">New terminal</p>
        <p className="m-0 text-sm text-body">
          This register is waiting to be provisioned — continue in the setup
          wizard to connect it with HQ.
        </p>
      </div>
      <a href="/setup" className="btn-primary no-underline">
        Set up this terminal
      </a>
    </section>
  )
}

function App() {
  const session = useSession()
  const navigate = useNavigate()
  const setup = useSetupStatus()

  useEffect(() => {
    // Signed-in staff go straight to the register.
    if (session.user) void navigate({ to: '/pos', replace: true })
  }, [session.user, navigate])

  // Unknown state (backend down) shows no CTA.
  const setupData = setup.data
  const unprovisioned = setupData !== undefined && !setupData.provisioned
  // Mid-wizard: identity saved, HQ pairing still pending.
  const awaitingPairing =
    setupData !== undefined && setupData.identity && !setupData.provisioned

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="rise-in relative overflow-hidden py-10 sm:py-16">
        <span
          aria-hidden="true"
          className="orb orb-sky -left-24 -top-16 h-72 w-72"
        />
        <span
          aria-hidden="true"
          className="orb orb-rose -right-28 top-8 h-80 w-80"
        />
        {/* Landing moment: centered display copy between the corner orbs
            (DESIGN_SYSTEM §5 — landing/brand copy is centered, not edge-hugging). */}
        <div className="relative flex flex-col items-center text-center">
          <p className="kicker mb-4">Multi-Outlet F&amp;B Platform</p>
          <h1 className="mb-6 max-w-3xl font-display text-display-md text-ink sm:text-display-xl lg:text-display-mega">
            Outlet point of sale.
          </h1>
          <p className="mb-8 max-w-2xl text-body-md text-body sm:text-lg sm:leading-relaxed">
            Fast local sales from the last synchronized catalog, live stock
            guards and receipts that keep working even when HQ is unreachable.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {unprovisioned ? (
              <a href="/setup" className="btn-primary no-underline">
                Set up this terminal
              </a>
            ) : null}
            <a
              href="/api/v1/docs"
              className={`${unprovisioned ? 'btn-outline' : 'btn-primary'} no-underline`}
            >
              API Documentation
            </a>
          </div>
        </div>
      </section>

      <SetupCard unprovisioned={awaitingPairing} />

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            'Local-First Sales',
            'Sales commit to the outlet database; HQ sync never blocks checkout.',
          ],
          [
            'Stock Guards',
            'Nonnegative balances enforced in PostgreSQL, not the browser.',
          ],
          [
            'Idempotent Checkout',
            'Retries reuse the same key — never double-charge a sale.',
          ],
          [
            'Sync Visibility',
            'Menu revision, pending uploads and last sync, always visible.',
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
