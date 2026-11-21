/** Feature-scoped TanStack Query key factory for outlet users (AGENTS §4.2). */
export const userKeys = {
  all: ['users'] as const,
  list: () => [...userKeys.all, 'list'] as const,
  roles: () => [...userKeys.all, 'roles'] as const,
}
