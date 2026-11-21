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
      <p className="kicker mb-2">Sites</p>
      <h1 className="mb-6 font-display text-display-md text-ink">Outlets</h1>

      <section className="card-panel p-6">
        {outlets.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading outlets…
          </p>
        ) : outlets.isError ? (
          <p role="alert" className="m-0 text-sm text-error">
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
                className="feature-card p-4 no-underline"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="badge-pill">{outlet.code}</span>
                  <span className="money text-xs font-medium text-muted-foreground">
                    rev {outlet.catalogRevision}
                  </span>
                </div>
                <p className="m-0 text-sm font-medium text-ink">
                  {outlet.name}
                </p>
                <p className="m-0 mt-1 text-xs text-body">{outlet.timezone}</p>
                <p className="m-0 mt-3 text-xs font-medium text-ink">
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
          className="card-panel mt-6 grid gap-3 p-6 sm:grid-cols-3"
        >
          <p className="kicker m-0 col-span-full">
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
              className="text-input font-normal"
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
              className="text-input font-normal"
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
              className="text-input font-normal"
            />
          </label>
          <div className="col-span-full flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={createOutlet.isPending}
              className="btn-primary btn-sm"
            >
              Create outlet
            </button>
            {error ? (
              <p role="alert" className="m-0 text-xs text-error">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </main>
  )
}
