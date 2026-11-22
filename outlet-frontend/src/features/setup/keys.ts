/** Feature-scoped TanStack Query key factory for terminal setup (AGENTS §4.2). */
export const setupKeys = {
  all: ['setup'] as const,
  status: () => [...setupKeys.all, 'status'] as const,
}
