import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/sales')({
  component: () => (
    <main className="page-wrap py-16">
      <p className="island-kicker mb-2">Register history</p>
      <h1 className="mb-4 text-2xl font-semibold text-[var(--sea-ink)]">
        Sales
      </h1>
      <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
        Sales history and receipt details land with the history feature.
      </p>
    </main>
  ),
})
