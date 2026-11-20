import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { outletsControllerCreateOutlet } from '#/api/generated/clients/outletsControllerCreateOutlet'
import { outletsControllerListOutlets } from '#/api/generated/clients/outletsControllerListOutlets'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'

import { outletKeys } from '#/features/outlets/keys'

export const Route = createFileRoute('/_auth/outlets/')({
  component: OutletsPage,
})

const outletSchema = z.object({
  code: z.string().min(1, 'Code is required.').max(8),
  name: z.string().min(1, 'Name is required.').max(120),
  timezone: z.string().min(1, 'Timezone is required.'),
})

function OutletsPage() {
  const session = useSession()
  const canWrite = hasPermission(session.user, 'outlets.write')
  const queryClient = useQueryClient()
  const outlets = useQuery({
    queryKey: outletKeys.list(),
    queryFn: () => outletsControllerListOutlets(),
  })

  const [form, setForm] = useState({ code: '', name: '', timezone: 'UTC' })
  const [error, setError] = useState<string | null>(null)

  const createOutlet = useMutation({
    mutationFn: (body: { code: string; name: string; timezone: string }) =>
      outletsControllerCreateOutlet({ body }),
    onSuccess: () => {
      setForm({ code: '', name: '', timezone: 'UTC' })
      setError(null)
      void queryClient.invalidateQueries({ queryKey: outletKeys.list() })
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Failed to create outlet.',
      ),
  })

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = outletSchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid outlet.')
      return
    }
    createOutlet.mutate(parsed.data)
  }

  return (
    <main className="page-wrap py-10">
      <p className="island-kicker mb-2">Sites</p>
      <h1 className="mb-6 text-2xl font-semibold text-[var(--sea-ink)]">
        Outlets
      </h1>

      <section className="island-shell rounded-2xl p-6">
        {outlets.isPending ? (
          <p
            className="m-0 text-sm text-[var(--sea-ink-soft)]"
            aria-busy="true"
          >
            Loading outlets…
          </p>
        ) : outlets.isError ? (
          <p role="alert" className="m-0 text-sm text-[#a03030]">
            {outlets.error instanceof ApiError
              ? `${outlets.error.code}: ${outlets.error.message}`
              : 'Failed to load outlets.'}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {outlets.data.map((outlet) => (
              <Link
                key={outlet.id}
                to="/outlets/$outletId"
                params={{ outletId: outlet.id }}
                className="rounded-xl border border-[var(--chip-line)] bg-[var(--chip-bg)] p-4 no-underline transition hover:border-[#56c6be]"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="rounded-full bg-[rgba(86,198,190,0.16)] px-2.5 py-0.5 text-xs font-semibold text-[#2f8f83]">
                    {outlet.code}
                  </span>
                  <span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
                    rev {outlet.catalogRevision}
                  </span>
                </div>
                <p className="m-0 text-sm font-semibold text-[var(--sea-ink)]">
                  {outlet.name}
                </p>
                <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">
                  {outlet.timezone}
                </p>
                <p className="m-0 mt-3 text-xs font-semibold text-[#2f8f83]">
                  Assignments &amp; keys →
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={handleCreate}
          className="island-shell mt-6 grid gap-3 rounded-2xl p-6 sm:grid-cols-3"
        >
          <p className="m-0 col-span-full text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Provision outlet (creates its revision-0 catalog row)
          </p>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Code (1–8 chars)
            <input
              value={form.code}
              onChange={(event) =>
                setForm({ ...form, code: event.target.value.toUpperCase() })
              }
              placeholder="D"
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Name
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="Outlet D"
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            IANA timezone
            <input
              value={form.timezone}
              onChange={(event) =>
                setForm({ ...form, timezone: event.target.value })
              }
              placeholder="Asia/Dhaka"
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <div className="col-span-full flex items-center gap-3">
            <button
              type="submit"
              disabled={createOutlet.isPending}
              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              Create outlet
            </button>
            {error ? (
              <p role="alert" className="m-0 text-xs text-[#a03030]">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </main>
  )
}
