/**
 * HQ-side permission strings (PRD §3, §9.3). Frontend permission checks are
 * UX only — every HQ route re-validates JWT + permission server-side.
 *
 * This module owns the app-wide `SessionUser` type: everything else imports
 * it from here so `permissions` is always the narrowed `HqPermission[]`, never
 * a raw `string[]` (backend sends strings; `parseSessionUser` narrows them).
 */
export const HQ_PERMISSIONS = [
  'menu.read',
  'menu.write',
  'outlets.read',
  'outlets.write',
  'assignments.read',
  'assignments.write',
  'keys.manage',
  'users.read',
  'users.write',
  'reports.read',
  'sync.read',
  'audit.read',
] as const satisfies readonly string[]

export type HqPermission = (typeof HQ_PERMISSIONS)[number]

const HQ_PERMISSION_SET: ReadonlySet<string> = new Set(HQ_PERMISSIONS)

/** Runtime guard narrowing an arbitrary backend string to `HqPermission`. */
export function isHqPermission(value: string): value is HqPermission {
  return HQ_PERMISSION_SET.has(value)
}

/**
 * Narrow the permission strings the backend sends to the known catalog.
 * Unknown codes are dropped, not fatal: the UI is cosmetic (AGENTS §4.2) and
 * the backend re-validates every permission server-side.
 */
export function toHqPermissions(values: readonly string[]): HqPermission[] {
  return values.filter(isHqPermission)
}

export type SessionUser = {
  id: string
  email: string
  roleCodes: string[]
  permissions: HqPermission[]
}

export function hasPermission(
  user: Pick<SessionUser, 'permissions'> | null | undefined,
  required: HqPermission,
): boolean {
  return user?.permissions.includes(required) ?? false
}
