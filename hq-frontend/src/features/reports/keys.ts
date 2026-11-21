export const reportKeys = {
  all: ['reports'] as const,
  revenue: (filters: { from: string; to: string }) =>
    [...reportKeys.all, 'revenue-by-outlet', filters] as const,
  topItems: (filters: { outletId: string; from: string; to: string }) =>
    [...reportKeys.all, 'top-items', filters] as const,
}
