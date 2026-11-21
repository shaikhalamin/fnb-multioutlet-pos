/**
 * Outlet permission catalog (PRD §3, §9.3). Guards, seeds and the users
 * module share this single list; permission strings are dot-case and stable.
 */
export const OUTLET_PERMISSIONS = [
  'menu.read',
  'sales.create',
  'sales.read',
  'inventory.read',
  'inventory.adjust',
  'sync.read',
  'users.read',
  'users.write',
] as const;

export type OutletPermission = (typeof OUTLET_PERMISSIONS)[number];

/** Role code → permission codes for the seeded default roles (PRD §3). */
export const DEFAULT_OUTLET_ROLES: ReadonlyArray<{
  code: string;
  name: string;
  permissions: readonly OutletPermission[];
}> = [
  {
    code: 'OUTLET_MANAGER',
    name: 'Outlet Manager',
    permissions: OUTLET_PERMISSIONS,
  },
  {
    code: 'OUTLET_CASHIER',
    name: 'Outlet Cashier',
    permissions: ['menu.read', 'sales.create', 'sales.read'],
  },
  {
    code: 'OUTLET_INVENTORY_CLERK',
    name: 'Outlet Inventory Clerk',
    permissions: ['menu.read', 'inventory.read', 'inventory.adjust'],
  },
];
