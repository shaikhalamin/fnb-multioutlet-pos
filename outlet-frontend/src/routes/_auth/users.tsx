import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/users')({
  component: () => (
    <main className="page-wrap py-16">
      <p className="island-kicker mb-2">Administration</p>
      <h1 className="mb-4 text-2xl font-semibold text-[var(--sea-ink)]">
        Outlet users
      </h1>
      <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
        Local user management lands with the users feature.
      </p>
    </main>
  ),
})
