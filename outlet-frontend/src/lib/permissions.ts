/**
 * Outlet-side permission strings (PRD §3, §9.3). Frontend permission checks
 * are UX only — every outlet route re-validates JWT + permission server-side.
 *
 * This module owns the app-wide `SessionUser` type: everything else imports
 * it from here so `permissions` is always the narrowed `OutletPermission[]`,
 * never a raw `string[]` (backend sends strings; `parseSessionUser` narrows
 * them).
 */
export const OUTLET_PERMISSIONS = [
  'menu.read',
  'sales.create',
  'sales.read',
  'inventory.read',
  'inventory.adjust',
  'sync.read',
  // Privileged, audited emergency actions (PRD §8.8) — managers only.
  'sync.override',
  // Rotating the stored HQ machine key (PRD FR-10) — managers only.
  'sync.manage',
  'users.read',
  'users.write',
] as const satisfies readonly string[]

export type OutletPermission = (typeof OUTLET_PERMISSIONS)[number]

const OUTLET_PERMISSION_SET: ReadonlySet<string> = new Set(OUTLET_PERMISSIONS)

/** Runtime guard narrowing an arbitrary backend string to `OutletPermission`. */
export function isOutletPermission(value: string): value is OutletPermission {
  return OUTLET_PERMISSION_SET.has(value)
}

/**
 * Narrow the permission strings the backend sends to the known catalog.
 * Unknown codes are dropped, not fatal: the UI is cosmetic (AGENTS §4.2) and
 * the backend re-validates every permission server-side.
 */
export function toOutletPermissions(
  values: readonly string[],
): OutletPermission[] {
  return values.filter(isOutletPermission)
}

export type SessionUser = {
  id: string
  email: string
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
