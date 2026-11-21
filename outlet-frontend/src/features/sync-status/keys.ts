/** Feature-scoped TanStack Query key factory for sync status (AGENTS §4.2). */
export const syncKeys = {
  all: ['sync'] as const,
  status: () => [...syncKeys.all, 'status'] as const,
}
