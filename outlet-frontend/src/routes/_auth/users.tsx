import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { usersControllerCreateUser } from '#/api/generated/clients/usersControllerCreateUser'
import { usersControllerListRoles } from '#/api/generated/clients/usersControllerListRoles'
import { usersControllerListUsers } from '#/api/generated/clients/usersControllerListUsers'
import { usersControllerUpdateUser } from '#/api/generated/clients/usersControllerUpdateUser'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { userKeys } from '#/features/users/keys'

export const Route = createFileRoute('/_auth/users')({ component: UsersPage })

const createUserSchema = z.object({
  email: z.string().email('Enter a valid email.'),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  roleCodes: z.array(z.string()).min(1, 'Pick at least one role.'),
})

function UsersPage() {
  const session = useSession()
  const canRead = hasPermission(session.user, 'users.read')
  const canWrite = hasPermission(session.user, 'users.write')
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const users = useQuery({
    queryKey: userKeys.list(),
    queryFn: () => usersControllerListUsers(),
  })
  const roles = useQuery({
    queryKey: userKeys.roles(),
    queryFn: () => usersControllerListRoles(),
  })

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  // Inline role editor: which user row is being edited + the draft role set.
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingRoles, setEditingRoles] = useState<string[]>([])

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: userKeys.list() })

  const createUser = useMutation({
    mutationFn: (body: {
      email: string
      password: string
      roleCodes: string[]
    }) => usersControllerCreateUser({ body, throwOnError: true }),
    onSuccess: () => {
      setEmail('')
      setPassword('')
      setError(null)
      invalidate()
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Failed to create user.',
      ),
  })

  const updateUser = useMutation({
    mutationFn: (input: {
      id: string
      body: { status?: 'ACTIVE' | 'DISABLED'; roleCodes?: string[] }
    }) =>
      usersControllerUpdateUser({
        path: { id: input.id },
        body: input.body,
        throwOnError: true,
      }),
    onSuccess: invalidate,
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Update failed.',
      ),
  })

  if (!canRead) {
    return (
      <main className="page-wrap py-16">
        <p
          role="alert"
          className="island-shell rounded-2xl p-6 text-sm text-[#a03030]"
        >
          You do not have permission to manage users.
        </p>
      </main>
    )
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = createUserSchema.safeParse({
      email,
      password,
      roleCodes: selectedRoles,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid user.')
      return
    }
    createUser.mutate(parsed.data)
  }

  function toggleRole(code: string): void {
    setSelectedRoles((current) =>
      current.includes(code)
        ? current.filter((entry) => entry !== code)
        : [...current, code],
    )
  }

  function toggleEditingRole(code: string): void {
    setEditingRoles((current) =>
      current.includes(code)
        ? current.filter((entry) => entry !== code)
        : [...current, code],
    )
  }

  function saveRoles(userId: string): void {
    if (editingRoles.length === 0) {
      setError('Pick at least one role.')
      return
    }
    updateUser.mutate(
      { id: userId, body: { roleCodes: editingRoles } },
      { onSuccess: () => setEditingUserId(null) },
    )
  }

  return (
    <main className="page-wrap py-10">
      <p className="island-kicker mb-2">Administration</p>
      <h1 className="mb-6 text-2xl font-semibold text-[var(--sea-ink)]">
        Outlet users
      </h1>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-[rgba(235,87,87,0.12)] px-3 py-2 text-sm text-[#a03030]"
        >
          {error}
        </p>
      ) : null}

      <section className="island-shell mb-6 overflow-x-auto rounded-2xl p-6">
        <h2 className="m-0 mb-4 text-base font-semibold text-[var(--sea-ink)]">
          Local staff accounts
        </h2>
        {users.isPending ? (
          <p
            className="m-0 text-sm text-[var(--sea-ink-soft)]"
            aria-busy="true"
          >
            Loading users…
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-xs uppercase tracking-wide text-[var(--sea-ink-soft)]">
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Roles</th>
                <th className="py-2 pr-4">Status</th>
                {canWrite ? <th className="py-2">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {users.data?.flatMap((user) => {
                const editing = editingUserId === user.id
                return [
                  <tr
                    key={user.id}
                    className="border-b border-[var(--line)]/60"
                  >
                    <td className="py-2 pr-4 font-medium text-[var(--sea-ink)]">
                      {user.email}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {user.roleCodes.map((code) => (
                          <span
                            key={code}
                            className="rounded-full bg-[rgba(86,198,190,0.16)] px-2 py-0.5 text-xs font-semibold text-[#2f8f83]"
                          >
                            {code}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={
                          user.status === 'ACTIVE'
                            ? 'rounded-full bg-[rgba(52,199,89,0.15)] px-2 py-0.5 text-xs font-semibold text-[#1d7a3f]'
                            : 'rounded-full bg-[rgba(120,120,120,0.14)] px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]'
                        }
                      >
                        {user.status}
                      </span>
                    </td>
                    {canWrite ? (
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingUserId(editing ? null : user.id)
                              setEditingRoles([...user.roleCodes])
                            }}
                          >
                            {editing ? 'Cancel roles' : 'Edit roles'}
                          </button>
                          {user.status === 'ACTIVE' ? (
                            <button
                              type="button"
                              disabled={user.id === session.user?.id}
                              title={
                                user.id === session.user?.id
                                  ? 'You cannot disable your own account.'
                                  : undefined
                              }
                              className="text-[#a03030] disabled:opacity-40"
                              onClick={() =>
                                updateUser.mutate({
                                  id: user.id,
                                  body: { status: 'DISABLED' },
                                })
                              }
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                updateUser.mutate({
                                  id: user.id,
                                  body: { status: 'ACTIVE' },
                                })
                              }
                            >
                              Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    ) : null}
                  </tr>,
                  editing ? (
                    <tr
                      key={`${user.id}-roles`}
                      className="border-b border-[var(--line)]/60 bg-[var(--chip-bg)]"
                    >
                      <td colSpan={canWrite ? 4 : 3} className="px-2 py-3">
                        <fieldset className="m-0 border-0 p-0">
                          <legend className="mb-1 text-xs font-semibold">
                            Roles for {user.email}
                          </legend>
                          <div className="flex flex-wrap items-center gap-2">
                            {roles.data?.map((role) => (
                              <label
                                key={role.code}
                                className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink)]"
                                title={role.permissions.join(', ')}
                              >
                                <input
                                  type="checkbox"
                                  checked={editingRoles.includes(role.code)}
                                  onChange={() => toggleEditingRole(role.code)}
                                />
                                {role.code}
                              </label>
                            ))}
                            <button
                              type="button"
                              disabled={updateUser.isPending}
                              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                              onClick={() => saveRoles(user.id)}
                            >
                              Save roles
                            </button>
                          </div>
                        </fieldset>
                      </td>
                    </tr>
                  ) : null,
                ]
              })}
            </tbody>
          </table>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={handleCreate}
          className="island-shell grid gap-3 rounded-2xl p-6 sm:grid-cols-2"
        >
          <p className="m-0 col-span-full text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
            Create outlet user
          </p>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="new.cashier@outlet-a.local"
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Min 8 characters"
              className="rounded-lg border border-[var(--chip-line)] bg-[var(--card,#fff)] px-3 py-2 text-sm font-normal"
            />
          </label>
          <fieldset className="col-span-full m-0 border-0 p-0">
            <legend className="mb-1 text-xs font-semibold">Roles</legend>
            <div className="flex flex-wrap gap-2">
              {roles.data?.map((role) => (
                <label
                  key={role.code}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink)]"
                  title={role.permissions.join(', ')}
                >
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role.code)}
                    onChange={() => toggleRole(role.code)}
                  />
                  {role.code}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="col-span-full">
            <button
              type="submit"
              disabled={createUser.isPending}
              className="rounded-full bg-[linear-gradient(90deg,#2f8f83,#56c6be)] px-5 py-2 text-xs font-semibold text-white disabled:opacity-60"
            >
              Create user
            </button>
          </div>
        </form>
      ) : null}
    </main>
  )
}
