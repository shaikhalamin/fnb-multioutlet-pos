/**
 * HQ permission catalog (PRD §3, §9.3). Guards, seeds and the users module
 * share this single list; permission strings are dot-case and stable.
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
] as const;

export type HqPermission = (typeof HQ_PERMISSIONS)[number];

/** Role code → permission codes for the seeded default roles (PRD §3). */
export const DEFAULT_HQ_ROLES: ReadonlyArray<{
  code: string;
  name: string;
  permissions: readonly HqPermission[];
}> = [
  {
    code: 'HQ_SUPER_ADMIN',
    name: 'HQ Super Admin',
    permissions: HQ_PERMISSIONS,
  },
  {
    code: 'HQ_MENU_MANAGER',
    name: 'HQ Menu Manager',
    permissions: ['menu.read', 'menu.write', 'outlets.read', 'assignments.read', 'assignments.write'],
  },
  {
    code: 'HQ_ANALYST',
    name: 'HQ Analyst',
    permissions: ['outlets.read', 'reports.read', 'sync.read'],
  },
];
