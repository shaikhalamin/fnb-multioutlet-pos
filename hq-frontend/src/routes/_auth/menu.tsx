import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { ApiError } from '#/api/axios'
import { menuControllerCreateCategory } from '#/api/generated/clients/menuControllerCreateCategory'
import { menuControllerCreateItem } from '#/api/generated/clients/menuControllerCreateItem'
import { menuControllerListCategories } from '#/api/generated/clients/menuControllerListCategories'
import { menuControllerListItems } from '#/api/generated/clients/menuControllerListItems'
import { menuControllerUpdateCategory } from '#/api/generated/clients/menuControllerUpdateCategory'
import { menuControllerUpdateItem } from '#/api/generated/clients/menuControllerUpdateItem'
import { menuControllerListItemsStatus200Schema } from '#/api/generated/schemas/menuControllerListItemsSchema'
import { useSession } from '#/features/auth/session'
import { hasPermission } from '#/lib/permissions'
import { formatMinor } from '#/lib/utils'

import { menuKeys } from '#/features/menu/keys'

export const Route = createFileRoute('/_auth/menu')({ component: MenuPage })

const MINOR_PATTERN = /^(0|[1-9][0-9]*)$/

const categorySchema = z.object({
  name: z.string().min(1, 'Name is required.').max(80),
})

const itemSchema = z.object({
  sku: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'SKU must be alphanumeric with . _ - separators.',
    )
    .max(64),
  name: z.string().min(1, 'Name is required.').max(160),
  description: z.string().max(1_000).optional(),
  categoryId: z.string().uuid('Pick a category.'),
  defaultPriceMinor: z
    .string()
    .regex(
      MINOR_PATTERN,
      'Price must be a whole number of minor units (e.g. 1050 for $10.50).',
    ),
  currencyCode: z.literal('USD'),
})

type ItemForm = z.infer<typeof itemSchema>

function useCategories() {
  return useQuery({
    queryKey: menuKeys.categories(),
    queryFn: () => menuControllerListCategories(),
  })
}

function useItems() {
  return useQuery({
    queryKey: menuKeys.items({ status: undefined }),
    // Money-bearing payload (defaultPriceMinor): parse with the generated
    // Zod schema before use (AGENTS §4.2).
    queryFn: async () =>
      menuControllerListItemsStatus200Schema.parse(
        await menuControllerListItems({ query: { limit: 200 } }),
      ),
  })
}

function MenuPage() {
  const session = useSession()
  const canWrite = hasPermission(session.user, 'menu.write')

  if (!hasPermission(session.user, 'menu.read')) {
    return (
      <main className="page-wrap py-16">
        <p role="alert" className="card-panel p-6 text-sm text-error">
          You do not have permission to view the master menu.
        </p>
      </main>
    )
  }

  return (
    <main className="page-wrap py-10">
      <p className="kicker mb-2">Master menu</p>
      <h1 className="mb-6 font-display text-display-md text-ink">
        Categories &amp; items
      </h1>

      <CategoriesPanel canWrite={canWrite} />
      <ItemsPanel canWrite={canWrite} />
    </main>
  )
}

function CategoriesPanel({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const categories = useCategories()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const createCategory = useMutation({
    mutationFn: (body: { name: string }) =>
      menuControllerCreateCategory({ body }),
    onSuccess: () => {
      setName('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: menuKeys.categories() })
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Failed to create category.',
      ),
  })

  const archiveCategory = useMutation({
    mutationFn: (id: string) =>
      menuControllerUpdateCategory({
        path: { id },
        body: { status: 'ARCHIVED' },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: menuKeys.categories() }),
  })

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = categorySchema.safeParse({ name })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name.')
      return
    }
    createCategory.mutate(parsed.data)
  }

  return (
    <section className="card-panel mb-6 p-6">
      <h2 className="m-0 mb-4 font-display text-title-md text-ink">
        Categories
      </h2>
      <div className="flex flex-wrap gap-2">
        {categories.isPending ? (
          <p className="m-0 text-sm text-body" aria-busy="true">
            Loading…
          </p>
        ) : (
          categories.data?.map((category) => (
            <span
              key={category.id}
              className="badge-pill normal-case tracking-[0.08em]"
            >
              {category.name}
              {category.status === 'ARCHIVED' ? (
                <span className="font-medium text-muted-foreground">
                  (archived)
                </span>
              ) : canWrite ? (
                <button
                  type="button"
                  title="Archive category (requires no active items)"
                  onClick={() => archiveCategory.mutate(category.id)}
                  className="rounded-full px-1 text-muted-foreground hover:text-error"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>
      {canWrite ? (
        <form
          onSubmit={handleCreate}
          className="mt-4 flex flex-wrap items-center gap-2"
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New category name"
            className="text-input w-56 font-normal"
          />
          <button
            type="submit"
            disabled={createCategory.isPending}
            className="btn-primary btn-sm"
          >
            Add category
          </button>
          {error ? (
            <p role="alert" className="m-0 text-xs text-error">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  )
}

const emptyItem: ItemForm = {
  sku: '',
  name: '',
  description: '',
  categoryId: '',
  defaultPriceMinor: '',
  currencyCode: 'USD',
}

function ItemsPanel({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const categories = useCategories()
  const items = useItems()
  const [form, setForm] = useState<ItemForm>(emptyItem)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidateItems = () =>
    void queryClient.invalidateQueries({ queryKey: menuKeys.items() })

  const saveItem = useMutation({
    mutationFn: (input: { form: ItemForm; editingId: string | null }) => {
      const body = {
        name: input.form.name,
        description: input.form.description || '',
        categoryId: input.form.categoryId,
        defaultPriceMinor: input.form.defaultPriceMinor,
      }
      return input.editingId
        ? menuControllerUpdateItem({ path: { id: input.editingId }, body })
        : menuControllerCreateItem({
            body: {
              ...body,
              sku: input.form.sku,
              currencyCode: input.form.currencyCode,
            },
          })
    },
    onSuccess: () => {
      setForm(emptyItem)
      setEditingId(null)
      setError(null)
      invalidateItems()
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? `${cause.code}: ${cause.message}`
          : 'Failed to save item.',
      ),
  })

  const archiveItem = useMutation({
    mutationFn: (id: string) =>
      menuControllerUpdateItem({ path: { id }, body: { status: 'ARCHIVED' } }),
    onSuccess: invalidateItems,
  })
  const restoreItem = useMutation({
    mutationFn: (id: string) =>
      menuControllerUpdateItem({ path: { id }, body: { status: 'ACTIVE' } }),
    onSuccess: invalidateItems,
  })

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = itemSchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid item.')
      return
    }
    saveItem.mutate({ form: parsed.data, editingId })
  }

  return (
    <section className="card-panel p-6">
      <h2 className="m-0 mb-4 font-display text-title-md text-ink">
        Master items
      </h2>

      {items.isPending ? (
        <p className="m-0 text-sm text-body" aria-busy="true">
          Loading items…
        </p>
      ) : items.isError ? (
        <p role="alert" className="m-0 text-sm text-error">
          {items.error instanceof ApiError
            ? `${items.error.code}: ${items.error.message}`
            : 'Failed to load items.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                <th className="kicker py-2 pr-4">SKU</th>
                <th className="kicker py-2 pr-4">Name</th>
                <th className="kicker py-2 pr-4">Category</th>
                <th className="kicker py-2 pr-4">Default price</th>
                <th className="kicker py-2 pr-4">Status</th>
                <th className="kicker py-2 pr-4">v</th>
                {canWrite ? <th className="kicker py-2">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.data.map((item) => (
                <tr key={item.id} className="border-b border-hairline-soft">
                  <td className="py-2 pr-4 text-xs text-body">{item.sku}</td>
                  <td className="py-2 pr-4 font-medium text-ink">
                    {item.name}
                  </td>
                  <td className="py-2 pr-4 text-body">{item.categoryName}</td>
                  <td className="money py-2 pr-4">
                    {formatMinor(item.defaultPriceMinor, item.currencyCode)}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={
                        item.status === 'ACTIVE'
                          ? 'badge-pill badge-success'
                          : 'badge-pill badge-neutral'
                      }
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="money py-2 pr-4 text-xs text-muted-foreground">
                    {item.version}
                  </td>
                  {canWrite ? (
                    <td className="py-2">
                      <div className="flex gap-2 text-xs">
                        <button
                          type="button"
                          className="font-medium text-ink hover:underline"
                          onClick={() => {
                            setEditingId(item.id)
                            setForm({
                              sku: item.sku,
                              name: item.name,
                              description: item.description,
                              categoryId: item.categoryId,
                              defaultPriceMinor: item.defaultPriceMinor,
                              currencyCode: item.currencyCode as 'USD',
                            })
                            setError(null)
                          }}
                        >
                          Edit
                        </button>
                        {item.status === 'ACTIVE' ? (
                          <button
                            type="button"
                            className="font-medium text-error hover:underline"
                            onClick={() => archiveItem.mutate(item.id)}
                          >
                            Archive
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="font-medium text-ink hover:underline"
                            onClick={() => restoreItem.mutate(item.id)}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite ? (
        <form
          onSubmit={handleSubmit}
          className="mt-6 grid gap-3 rounded-xl border border-hairline bg-canvas-soft p-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          <p className="kicker m-0 col-span-full">
            {editingId ? 'Edit item (SKU immutable)' : 'Create item'}
          </p>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            SKU
            <input
              value={form.sku}
              disabled={editingId !== null}
              onChange={(event) =>
                setForm({ ...form, sku: event.target.value })
              }
              placeholder="BURGER-02"
              className="text-input font-normal disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            Name
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="Beef Burger"
              className="text-input font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            Category
            <select
              value={form.categoryId}
              onChange={(event) =>
                setForm({ ...form, categoryId: event.target.value })
              }
              className="text-input font-normal"
            >
              <option value="">Select…</option>
              {categories.data
                ?.filter((category) => category.status === 'ACTIVE')
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
            Default price (minor units)
            <input
              value={form.defaultPriceMinor}
              onChange={(event) =>
                setForm({ ...form, defaultPriceMinor: event.target.value })
              }
              placeholder="1000 = $10.00"
              className="text-input money font-normal"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink sm:col-span-2">
            Description
            <input
              value={form.description ?? ''}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              placeholder="Optional"
              className="text-input font-normal"
            />
          </label>
          <div className="col-span-full flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saveItem.isPending}
              className="btn-primary btn-sm"
            >
              {editingId ? 'Save changes' : 'Create item'}
            </button>
            {editingId ? (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null)
                  setForm(emptyItem)
                }}
                className="btn-outline btn-sm"
              >
                Cancel
              </button>
            ) : null}
            {error ? (
              <p role="alert" className="m-0 text-xs text-error">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  )
}
