/**
 * HQ-side permission strings (PRD §3, §9.3). Frontend permission checks are
 * UX only — every HQ route re-validates JWT + permission server-side.
 */
export type HqPermission =
  | 'menu.read'
  | 'menu.write'
  | 'outlets.read'
  | 'outlets.write'
  | 'assignments.write'
  | 'keys.manage'
  | 'reports.read'
  | 'sync.read'

export type SessionUser = {
  id: string
  roleCodes: string[]
  permissions: HqPermission[]
}

export function hasPermission(
  user: Pick<SessionUser, 'permissions'> | null | undefined,
  required: HqPermission,
): boolean {
  return user?.permissions.includes(required) ?? false
}
