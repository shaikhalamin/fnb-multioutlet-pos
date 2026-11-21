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
    }) => usersControllerCreateUser({ body }),
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
      usersControllerUpdateUser({ path: { id: input.id }, body: input.body }),
    onSuccess: invalidate,
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Update failed.',
      ),
  })

  if (!hasPermission(session.user, 'users.read')) {
    return (
      <main className="page-wrap py-16">
        <p role="alert" className="card-panel p-6 text-sm text-error">
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
      <p className="kicker mb-2">Administration</p>
      <h1 className="mb-6 font-display text-display-md text-ink">HQ users</h1>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </p>
      ) : null}

      <section className="card-panel mb-6 p-6">
        <h2 className="m-0 mb-4 font-display text-title-md text-ink">
          Staff accounts
        </h2>
        {users.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading users…
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="kicker py-2 pr-4">Email</th>
                  <th className="kicker py-2 pr-4">Roles</th>
                  <th className="kicker py-2 pr-4">Status</th>
                  {canWrite ? <th className="kicker py-2">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {users.data?.flatMap((user) => {
                  const editing = editingUserId === user.id
                  return [
                    <tr key={user.id} className="border-b border-hairline-soft">
                      <td className="py-2 pr-4 font-medium text-ink">
                        {user.email}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {user.roleCodes.map((code) => (
                            <span
                              key={code}
                              className="badge-pill normal-case tracking-[0.08em]"
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
                              ? 'badge-pill badge-success'
                              : 'badge-pill badge-neutral'
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
                              className="font-medium text-ink hover:underline"
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
                                className="font-medium text-error hover:underline disabled:opacity-40"
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
                                className="font-medium text-ink hover:underline"
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
                        className="border-b border-hairline-soft bg-canvas-soft"
                      >
                        <td colSpan={canWrite ? 4 : 3} className="px-2 py-3">
                          <fieldset className="m-0 border-0 p-0">
                            <legend className="kicker mb-1">
                              Roles for {user.email}
                            </legend>
                            <div className="flex flex-wrap items-center gap-2">
                              {roles.data?.map((role) => (
                                <label
                                  key={role.code}
                                  className="badge-pill cursor-pointer normal-case tracking-[0.08em]"
                                  title={role.permissions.join(', ')}
                                >
                                  <input
                                    type="checkbox"
                                    checked={editingRoles.includes(role.code)}
                                    onChange={() =>
                                      toggleEditingRole(role.code)
                                    }
                                  />
                                  {role.code}
                                </label>
                              ))}
                              <button
                                type="button"
                                disabled={updateUser.isPending}
                                className="btn-primary btn-sm"
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
          </div>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={handleCreate}
          className="card-panel grid gap-3 p-6 sm:grid-cols-2"
        >
          <p className="kicker m-0 col-span-full">Create HQ user</p>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="manager@fnb.local"
              className="text-input font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Min 8 characters"
              className="text-input font-normal"
            />
          </label>
          <fieldset className="col-span-full m-0 border-0 p-0">
            <legend className="kicker mb-1">Roles</legend>
            <div className="flex flex-wrap gap-2">
              {roles.data?.map((role) => (
                <label
                  key={role.code}
                  className="badge-pill cursor-pointer normal-case tracking-[0.08em]"
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
              className="btn-primary btn-sm"
            >
              Create user
            </button>
          </div>
        </form>
      ) : null}
    </main>
  )
}
