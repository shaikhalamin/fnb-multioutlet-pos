import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { auditControllerListLogs } from '#/api/generated/clients/auditControllerListLogs'
import { auditControllerListLogsStatus200Schema } from '#/api/generated/schemas/auditControllerListLogsSchema'
import { useSession } from '#/features/auth/session'
import { auditKeys } from '#/features/audit/keys'
import { hasPermission } from '#/lib/permissions'
import { formatInstantUtc } from '#/lib/utils'

const dayPattern = /^\d{4}-\d{2}-\d{2}$/

const searchSchema = z.object({
  action: z.string().trim().min(1).max(120).optional().catch(undefined),
  actorId: z.string().uuid().optional().catch(undefined),
  from: z.string().regex(dayPattern).optional().catch(undefined),
  to: z.string().regex(dayPattern).optional().catch(undefined),
})

const PAGE_SIZE = 50

export const Route = createFileRoute('/_auth/audit')({
  validateSearch: searchSchema.parse,
  component: AuditPage,
})

function AuditPage() {
  const session = useSession()
  const navigate = useNavigate()
  const { action, actorId, from, to } = Route.useSearch()

  const [draft, setDraft] = useState({
    action: action ?? '',
    actorId: actorId ?? '',
    from: from ?? '',
    to: to ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  const logs = useInfiniteQuery({
    queryKey: auditKeys.logs({ action, actorId, from, to }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      // `throwOnError: false` keeps the result envelope so the page cursor
      // (promoted to the x-page-cursor header by the shared axios layer)
      // survives alongside the parsed rows.
      const result = await auditControllerListLogs({
        throwOnError: false,
        query: {
          limit: PAGE_SIZE,
          ...(action ? { action } : {}),
          ...(actorId ? { actorId } : {}),
          ...(from ? { from: `${from}T00:00:00Z` } : {}),
          ...(to ? { to: `${to}T00:00:00Z` } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      })
      return {
        rows: auditControllerListLogsStatus200Schema.parse(result.data),
        nextCursor: result.headers.get('x-page-cursor') ?? undefined,
      }
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })

  if (!hasPermission(session.user, 'audit.read')) {
    return (
      <main className="page-wrap py-10">
        <p role="alert" className="m-0 text-sm text-error">
          You do not have permission to view the audit trail.
        </p>
      </main>
    )
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedActor = draft.actorId.trim()
    if (trimmedActor && !z.string().uuid().safeParse(trimmedActor).success) {
      setError('Actor must be a UUID.')
      return
    }
    if (draft.from && draft.to && new Date(draft.to) <= new Date(draft.from)) {
      setError('The end date must be after the start date.')
      return
    }
    setError(null)
    void navigate({
      to: '/audit',
      search: {
        action: draft.action.trim() || undefined,
        actorId: trimmedActor || undefined,
        from: draft.from || undefined,
        to: draft.to || undefined,
      },
    })
  }

  const rows = logs.data?.pages.flatMap((page) => page.rows) ?? []

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Compliance</p>
      <h1 className="mb-2 font-display text-display-md text-ink">
        Audit trail
      </h1>
      <p className="mb-6 text-sm text-body">
        Immutable, newest first. Rows never change after they are written.
      </p>

      <form onSubmit={applyFilters} className="mb-6 grid gap-3 sm:grid-cols-5">
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Action
          <input
            value={draft.action}
            onChange={(event) =>
              setDraft({ ...draft, action: event.target.value })
            }
            placeholder="auth.login_failed"
            className="form-input font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Actor (UUID)
          <input
            value={draft.actorId}
            onChange={(event) =>
              setDraft({ ...draft, actorId: event.target.value })
            }
            placeholder="3f7a4d60-…"
            className="form-input font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          From (UTC)
          <input
            type="date"
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
            className="form-input font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          To (UTC)
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            className="form-input font-normal"
          />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn-primary btn-sm">
            Apply filters
          </button>
        </div>
        {error ? (
          <p role="alert" className="m-0 text-xs text-error sm:col-span-5">
            {error}
          </p>
        ) : null}
      </form>

      <section className="card-panel p-6">
        {logs.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading audit entries…
          </p>
        ) : logs.isError ? (
          <p role="alert" className="m-0 text-sm text-error">
            {logs.error instanceof ApiError
              ? `${logs.error.code}: ${logs.error.message}`
              : 'Failed to load audit entries.'}
          </p>
        ) : (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline-soft text-left">
                  <th className="kicker py-2 pr-4 font-semibold">When (UTC)</th>
                  <th className="kicker py-2 pr-4 font-semibold">Actor</th>
                  <th className="kicker py-2 pr-4 font-semibold">Action</th>
                  <th className="kicker py-2 pr-4 font-semibold">Entity</th>
                  <th className="kicker py-2 font-semibold">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-hairline-soft align-top"
                  >
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {formatInstantUtc(row.occurredAt)}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <span className="badge-pill">{row.actorType}</span>{' '}
                      <span className="text-xs text-muted-foreground">
                        {row.actorId ? row.actorId.slice(0, 8) : '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-medium text-ink">
                      {row.action}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {row.entityType
                        ? `${row.entityType}${row.entityId ? ` · ${row.entityId.slice(0, 8)}` : ''}`
                        : '—'}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {Object.keys(row.metadata).length === 0
                        ? '—'
                        : JSON.stringify(row.metadata)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 ? (
              <p className="m-0 mt-4 text-sm text-body">
                No audit entries match these filters.
              </p>
            ) : null}
            {logs.hasNextPage ? (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void logs.fetchNextPage()}
                  disabled={logs.isFetchingNextPage}
                  className="btn-outline btn-sm"
                >
                  {logs.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}
