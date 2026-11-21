import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/inventory')({
  component: () => (
    <main className="page-wrap py-16">
      <p className="island-kicker mb-2">Back of house</p>
      <h1 className="mb-4 text-2xl font-semibold text-[var(--sea-ink)]">
        Inventory
      </h1>
      <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
        Balances and audited adjustments land with the inventory feature.
      </p>
    </main>
  ),
})
