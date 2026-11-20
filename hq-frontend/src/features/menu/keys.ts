/** Feature-scoped TanStack Query key factory for the master menu (AGENTS §4.2). */
export const menuKeys = {
  all: ['menu'] as const,
  categories: () => [...menuKeys.all, 'categories'] as const,
  items: (filters?: Record<string, unknown>) =>
    [...menuKeys.all, 'items', filters ?? {}] as const,
}
