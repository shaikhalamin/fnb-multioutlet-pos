import { DataSource } from 'typeorm';
import { buildCliDataSource } from './data-source.js';
import { CatalogItemEntity } from './entities/catalog-item.entity.js';
import { InventoryBalanceEntity } from './entities/inventory-balance.entity.js';
import { OutletIdentityEntity } from './entities/outlet-identity.entity.js';
import {
  ensureCounters,
  ensurePermissionsAndRoles,
  ensureSyncState,
  ensureUserWithRoles,
} from '../modules/setup/provisioning.js';

/**
 * Idempotent DEV seed (PRD §6.2 bootstrap): provisioned identity, the
 * permission catalog + default roles, demo staff accounts, and a local
 * catalog snapshot that simulates a completed menu sync (fixed well-known
 * item UUIDs, `applied_revision = 1`, fresh `last_sync_at` so the offline
 * grace policy passes). Natural keys make re-runs no-ops; existing rows are
 * never overwritten.
 *
 * Outlet identity is never an environment input (PRD §3, §8.7): the seed
 * provisions the fixed demo Outlet-A identity below into an empty terminal;
 * an existing identity row — e.g. one written by the setup wizard — is kept
 * as-is and only topped up with demo data.
 */

const log = (msg: string, payload: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: 'info', service: 'outlet-backend', msg, ...payload })}\n`,
  );
};

/** Fixed demo identity for the local outlet-A stack (mirrors PRD examples). */
const DEFAULT_COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const DEMO_OUTLET_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_OUTLET_CODE = 'A';

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
  const repo = dataSource.getRepository(OutletIdentityEntity);
  const existing = await repo.findOne({ where: {} });
  if (existing) {
    log('seed_identity_exists', { outletId: existing.outletId });
    return { outletId: existing.outletId, outletCode: existing.outletCode };
  }
  await repo.insert(
    repo.create({
      outletId: DEMO_OUTLET_ID,
      outletCode: DEMO_OUTLET_CODE,
      companyId: process.env.SEED_OUTLET_COMPANY_ID ?? DEFAULT_COMPANY_ID,
      timezone: process.env.SEED_OUTLET_TIMEZONE ?? 'UTC',
      currencyCode: 'USD',
    }),
  );
  log('seed_identity_created', { outletId: DEMO_OUTLET_ID, outletCode: DEMO_OUTLET_CODE });
  return { outletId: DEMO_OUTLET_ID, outletCode: DEMO_OUTLET_CODE };
}

async function seedUsers(
  dataSource: DataSource,
  roleIds: Map<string, string>,
): Promise<void> {
  for (const demo of DEMO_USERS) {
    const email = (process.env[`SEED_OUTLET_${demo.envPrefix}_EMAIL`] ?? demo.defaultEmail).toLowerCase();
    const password = process.env[`SEED_OUTLET_${demo.envPrefix}_PASSWORD`] ?? demo.defaultPassword;
    const roleId = roleIds.get(demo.roleCode);
    if (!roleId) throw new Error(`role missing from seed catalog: ${demo.roleCode}`);
    const { created } = await ensureUserWithRoles(dataSource.manager, { email, password, roleId });
    if (created) {
      log('seed_user_created', { email, role: demo.roleCode });
      if (!process.env[`SEED_OUTLET_${demo.envPrefix}_PASSWORD`]) {
        log('seed_user_default_password', {
          warning: `SEED_OUTLET_${demo.envPrefix}_PASSWORD not set; local development default credentials in use`,
          email,
        });
      }
    } else {
      log('seed_user_exists', { email });
    }
  }
}

async function seedCatalogAndSyncState(dataSource: DataSource, outletId: string): Promise<void> {
  const itemsRepo = dataSource.getRepository(CatalogItemEntity);
  const balancesRepo = dataSource.getRepository(InventoryBalanceEntity);

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

  // Fresh checkpoint at revision 1: simulates a completed menu sync so the
  // offline grace policy passes (PRD §8.8); the pull worker keeps it current.
  await ensureSyncState(dataSource.manager, outletId, '1');
}

async function main(): Promise<void> {
  const dataSource = buildCliDataSource();
  try {
    await dataSource.initialize();
    const identity = await seedIdentity(dataSource);
    const roleIds = await ensurePermissionsAndRoles(dataSource.manager);
    await seedUsers(dataSource, roleIds);
    await seedCatalogAndSyncState(dataSource, identity.outletId);
    await ensureCounters(dataSource.manager, identity.outletId, identity.outletCode);
    log('seed_completed', identity);
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
