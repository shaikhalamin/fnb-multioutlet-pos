import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/pos')({
  component: () => (
    <main className="page-wrap py-16">
      <p className="island-kicker mb-2">Register</p>
      <h1 className="mb-4 text-2xl font-semibold text-[var(--sea-ink)]">
        Point of sale
      </h1>
      <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
        The POS screen lands with the checkout feature.
      </p>
    </main>
  ),
})
