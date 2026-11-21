/** Feature-scoped TanStack Query key factory for the POS (AGENTS §4.2). */
export const posKeys = {
  all: ['pos'] as const,
  menu: () => [...posKeys.all, 'menu'] as const,
}
