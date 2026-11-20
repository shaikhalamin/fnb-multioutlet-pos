/** Feature-scoped TanStack Query key factory for outlets & keys (AGENTS §4.2). */
export const outletKeys = {
  all: ['outlets'] as const,
  list: () => [...outletKeys.all, 'list'] as const,
  detail: (outletId: string) =>
    [...outletKeys.all, 'detail', outletId] as const,
  menu: (outletId: string) => [...outletKeys.all, 'menu', outletId] as const,
  keys: (outletId: string) => [...outletKeys.all, 'keys', outletId] as const,
}
