/**
 * Outlet-side permission strings (PRD §3, §9.3). Frontend permission checks
 * are UX only — every outlet route re-validates JWT + permission server-side.
 */
export type OutletPermission =
  | 'menu.read'
  | 'sales.create'
  | 'sales.read'
  | 'inventory.read'
  | 'inventory.adjust'
  | 'sync.read'

export type SessionUser = {
  id: string
  roleCodes: string[]
  permissions: OutletPermission[]
  outletId: string
}

export function hasPermission(
  user: Pick<SessionUser, 'permissions'> | null | undefined,
  required: OutletPermission,
): boolean {
  return user?.permissions.includes(required) ?? false
}
