/** Feature-scoped TanStack Query key factory for inventory (AGENTS §4.2). */
export const inventoryKeys = {
  all: ['inventory'] as const,
  balances: () => [...inventoryKeys.all, 'balances'] as const,
}
