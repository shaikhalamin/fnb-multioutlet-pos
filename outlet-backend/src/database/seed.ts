import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { loadEnvFileGaps } from '../config/env.schema.js';
import { DEFAULT_OUTLET_ROLES, OUTLET_PERMISSIONS } from '../common/rbac/permissions.js';
import { buildCliDataSource } from './data-source.js';
import { CatalogItemEntity } from './entities/catalog-item.entity.js';
import { InventoryBalanceEntity } from './entities/inventory-balance.entity.js';
import { MenuSyncStateEntity } from './entities/menu-sync-state.entity.js';
import { OutletIdentityEntity } from './entities/outlet-identity.entity.js';
import { OutletPermissionEntity } from './entities/outlet-permission.entity.js';
import { OutletRoleEntity } from './entities/outlet-role.entity.js';
import { OutletRolePermissionEntity } from './entities/outlet-role-permission.entity.js';
import { OutletUserEntity } from './entities/outlet-user.entity.js';
import { OutletUserRoleEntity } from './entities/outlet-user-role.entity.js';
import { OutboxCounterEntity } from './entities/outbox-counter.entity.js';
import { ReceiptCounterEntity } from './entities/receipt-counter.entity.js';

/**
 * Idempotent outlet seed (PRD §6.2 bootstrap): provisioned identity, the
 * permission catalog + default roles, demo staff accounts, and a local
 * catalog snapshot that simulates a completed menu sync (fixed well-known
 * item UUIDs, `applied_revision = 1`, fresh `last_sync_at` so the offline
 * grace policy passes). Natural keys make re-runs no-ops; existing rows are
 * never overwritten. The Phase-3 pull worker reconciles the catalog with HQ.
 */

const log = (msg: string, payload: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'info', service: 'outlet-backend', msg, ...payload })}\n`,
  );
};

/** Fixed demo identity for the local outlet-A stack (mirrors PRD examples). */
const DEFAULT_COMPANY_ID = '22222222-2222-4222-8222-222222222222';

const DEMO_USERS: ReadonlyArray<{
  envPrefix: string;
  defaultEmail: string;
  defaultPassword: string;
  roleCode: string;
}> = [
  { envPrefix: 'MANAGER', defaultEmail: 'manager@outlet-a.local', defaultPassword: 'Manager123!', roleCode: 'OUTLET_MANAGER' },
  { envPrefix: 'CASHIER', defaultEmail: 'cashier@outlet-a.local', defaultPassword: 'Cashier123!', roleCode: 'OUTLET_CASHIER' },
  { envPrefix: 'CLERK', defaultEmail: 'clerk@outlet-a.local', defaultPassword: 'Clerk123!', roleCode: 'OUTLET_INVENTORY_CLERK' },
];

/** Demo catalog with fixed UUIDs so docs, seeds and e2e specs agree. */
const DEMO_CATALOG: ReadonlyArray<{
  menuItemId: string;
  assignmentId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  effectivePriceMinor: string;
  stock: string;
}> = [
  {
    menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
    assignmentId: '31fe8f6b-02b8-409d-b1fa-6c441f422949',
    sku: 'BURGER-01',
    name: 'Chicken Burger',
    description: 'Grilled chicken burger',
    category: 'Burgers',
    effectivePriceMinor: '1000',
    stock: '50',
  },
  {
    menuItemId: 'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4',
    assignmentId: '7bbca9d3-64d1-43b0-94ab-9da64d2a2f10',
    sku: 'PIZZA-01',
    name: 'Pizza',
    description: 'Margherita pizza',
    category: 'Pizza',
    effectivePriceMinor: '1500',
    stock: '40',
  },
  {
    menuItemId: '3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110',
    assignmentId: 'e5a1c9b7-92b3-45f1-8f6e-0f1a9d1c4b22',
    sku: 'COLA-01',
    name: 'Cola',
    description: 'Chilled cola 330ml',
    category: 'Drinks',
    effectivePriceMinor: '300',
    stock: '100',
  },
];

async function seedIdentity(dataSource: DataSource): Promise<{ outletId: string; outletCode: string }> {
  loadEnvFileGaps();
  const outletId = process.env.OUTLET_ID;
  const outletCode = process.env.OUTLET_CODE;
  if (!outletId || !outletCode) {
    throw new Error('OUTLET_ID and OUTLET_CODE are required to seed the outlet identity');
  }

  const repo = dataSource.getRepository(OutletIdentityEntity);
  const existing = await repo.findOne({ where: { outletId } });
  if (existing) {
    log('seed_identity_exists', { outletId });
    return { outletId: existing.outletId, outletCode: existing.outletCode };
  }
  await repo.insert(
    repo.create({
      outletId,
      outletCode,
      companyId: process.env.SEED_OUTLET_COMPANY_ID ?? DEFAULT_COMPANY_ID,
      timezone: process.env.SEED_OUTLET_TIMEZONE ?? 'UTC',
      currencyCode: 'USD',
    }),
  );
  log('seed_identity_created', { outletId, outletCode });
  return { outletId, outletCode };
}

async function seedPermissionsAndRoles(dataSource: DataSource): Promise<Map<string, string>> {
  const permissionsRepo = dataSource.getRepository(OutletPermissionEntity);
  const rolesRepo = dataSource.getRepository(OutletRoleEntity);
  const rolePermsRepo = dataSource.getRepository(OutletRolePermissionEntity);
  const permissionIds = new Map<string, string>();

  for (const code of OUTLET_PERMISSIONS) {
    const existing = await permissionsRepo.findOne({ where: { code } });
    if (existing) {
      permissionIds.set(code, existing.id);
      continue;
    }
    const saved = await permissionsRepo.save(permissionsRepo.create({ code, description: '' }));
    permissionIds.set(code, saved.id);
  }
  log('seed_permissions_ready', { count: permissionIds.size });

  const roleIds = new Map<string, string>();
  for (const role of DEFAULT_OUTLET_ROLES) {
    let entity = await rolesRepo.findOne({ where: { code: role.code } });
    if (!entity) {
      entity = await rolesRepo.save(rolesRepo.create({ code: role.code, name: role.name }));
      log('seed_role_created', { code: role.code, roleId: entity.id });
    }
    roleIds.set(role.code, entity.id);

    // Keep role → permission membership aligned with the catalog.
    for (const permission of role.permissions) {
      const permissionId = permissionIds.get(permission);
      if (!permissionId) continue;
      const existing = await rolePermsRepo.findOne({ where: { roleId: entity.id, permissionId } });
      if (!existing) {
        await rolePermsRepo.save(rolePermsRepo.create({ roleId: entity.id, permissionId }));
      }
    }
  }
  return roleIds;
}

async function seedUsers(dataSource: DataSource, roleIds: Map<string, string>): Promise<void> {
  const usersRepo = dataSource.getRepository(OutletUserEntity);
  const userRolesRepo = dataSource.getRepository(OutletUserRoleEntity);

  for (const demo of DEMO_USERS) {
    const email = (process.env[`SEED_OUTLET_${demo.envPrefix}_EMAIL`] ?? demo.defaultEmail).toLowerCase();
    const password = process.env[`SEED_OUTLET_${demo.envPrefix}_PASSWORD`] ?? demo.defaultPassword;

    const existing = await usersRepo
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email })
      .getOne();
    if (existing) {
      log('seed_user_exists', { email });
      continue;
    }

    const user = await usersRepo.save(
      usersRepo.create({ email, passwordHash: await bcrypt.hash(password, 12), status: 'ACTIVE' }),
    );
    const roleId = roleIds.get(demo.roleCode);
    if (!roleId) throw new Error(`role missing from seed catalog: ${demo.roleCode}`);
    await userRolesRepo.save(userRolesRepo.create({ userId: user.id, roleId }));
    log('seed_user_created', { email, role: demo.roleCode });
    if (!process.env[`SEED_OUTLET_${demo.envPrefix}_PASSWORD`]) {
      log('seed_user_default_password', {
        warning: `SEED_OUTLET_${demo.envPrefix}_PASSWORD not set; local development default credentials in use`,
        email,
      });
    }
  }
}

async function seedCatalogAndSyncState(dataSource: DataSource, outletId: string): Promise<void> {
  const itemsRepo = dataSource.getRepository(CatalogItemEntity);
  const balancesRepo = dataSource.getRepository(InventoryBalanceEntity);
  const syncStateRepo = dataSource.getRepository(MenuSyncStateEntity);

  for (const item of DEMO_CATALOG) {
    const existing = await itemsRepo.findOne({ where: { menuItemId: item.menuItemId } });
    if (!existing) {
      await itemsRepo.insert(
        itemsRepo.create({
          menuItemId: item.menuItemId,
          assignmentId: item.assignmentId,
          sku: item.sku,
          name: item.name,
          description: item.description,
          category: item.category,
          effectivePriceMinor: item.effectivePriceMinor,
          currencyCode: 'USD',
          active: true,
          hqItemVersion: 1,
          appliedRevision: '1',
        }),
      );
      log('seed_item_created', { menuItemId: item.menuItemId, sku: item.sku });
    }
    const balance = await balancesRepo.findOne({ where: { menuItemId: item.menuItemId } });
    if (!balance) {
      await balancesRepo.insert(
        balancesRepo.create({ menuItemId: item.menuItemId, quantityOnHand: item.stock, version: 1 }),
      );
      log('seed_balance_created', { menuItemId: item.menuItemId, quantityOnHand: item.stock });
    }
  }

  // Fresh checkpoint: simulates a completed menu sync so the offline grace
  // policy passes (PRD §8.8); the Phase-3 pull worker keeps it current.
  const syncState = await syncStateRepo.findOne({ where: { outletId } });
  if (!syncState) {
    await syncStateRepo.insert(
      syncStateRepo.create({
        outletId,
        lastAppliedRevision: '1',
        lastSyncAt: new Date(),
        snapshotId: null,
      }),
    );
    log('seed_sync_state_created', { outletId });
  }
}

async function seedCounters(dataSource: DataSource, outletId: string, outletCode: string): Promise<void> {
  const receiptsRepo = dataSource.getRepository(ReceiptCounterEntity);
  const outboxRepo = dataSource.getRepository(OutboxCounterEntity);

  if (!(await receiptsRepo.findOne({ where: { outletId } }))) {
    await receiptsRepo.insert(receiptsRepo.create({ outletId, nextNumber: '1', prefix: outletCode }));
    log('seed_receipt_counter_created', { outletId, prefix: outletCode });
  }
  if (!(await outboxRepo.findOne({ where: { outletId } }))) {
    await outboxRepo.insert(outboxRepo.create({ outletId, nextSequence: '1' }));
    log('seed_outbox_counter_created', { outletId });
  }
}

async function main(): Promise<void> {
  const dataSource = buildCliDataSource();
  try {
    await dataSource.initialize();
    const { outletId, outletCode } = await seedIdentity(dataSource);
    const roleIds = await seedPermissionsAndRoles(dataSource);
    await seedUsers(dataSource, roleIds);
    await seedCatalogAndSyncState(dataSource, outletId);
    await seedCounters(dataSource, outletId, outletCode);
    log('seed_completed', { outletId, outletCode });
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: 'outlet-backend',
      msg: 'seed_failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
