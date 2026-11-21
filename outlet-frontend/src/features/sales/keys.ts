/** Feature-scoped TanStack Query key factory for sales history (AGENTS §4.2). */
export const salesKeys = {
  all: ['sales'] as const,
  list: (range: { from?: string; to?: string }) =>
    [...salesKeys.all, 'list', range] as const,
  detail: (saleId: string) => [...salesKeys.all, 'detail', saleId] as const,
}
