import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { buildCliDataSource } from './data-source.js';
import { DEFAULT_HQ_ROLES, HQ_PERMISSIONS } from '../common/rbac/permissions.js';
import {
  generateOutletKeyId,
  generateOutletKeySecret,
  hashOutletKeySecret,
  OUTLET_KEY_SCOPES,
} from '../common/utils/outlet-key.js';
import { CompanyEntity } from './entities/company.entity.js';
import { HqPermissionEntity } from './entities/hq-permission.entity.js';
import { HqRoleEntity } from './entities/hq-role.entity.js';
import { HqRolePermissionEntity } from './entities/hq-role-permission.entity.js';
import { HqUserEntity } from './entities/hq-user.entity.js';
import { HqUserRoleEntity } from './entities/hq-user-role.entity.js';
import { MasterMenuItemEntity } from './entities/master-menu-item.entity.js';
import { MenuCategoryEntity } from './entities/menu-category.entity.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { OutletApiKeyEntity } from './entities/outlet-api-key.entity.js';
import { OutletCatalogRevisionEntity } from './entities/outlet-catalog-revision.entity.js';
import { OutletEntity } from './entities/outlet.entity.js';

/**
 * Idempotent HQ seed (PRD §6.1 bootstrap): company, permission catalog,
 * default roles, the first super admin, and (for local development) demo
 * outlets/categories/items used by the Phase-1 verification scenarios.
 * Natural keys make re-runs no-ops; existing rows are never overwritten.
 */

const log = (msg: string, payload: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', service: 'hq-backend', msg, ...payload })}\n`);
};

const DEFAULT_ADMIN_EMAIL = 'admin@fnb.local';
const DEFAULT_ADMIN_PASSWORD = 'Admin123!';

const DEMO_CATEGORIES = ['Burgers', 'Pizza', 'Drinks'] as const;

const DEMO_ITEMS: ReadonlyArray<{
  sku: string;
  name: string;
  description: string;
  category: string;
  defaultPriceMinor: string;
}> = [
  {
    sku: 'BURGER-01',
    name: 'Chicken Burger',
    description: 'Grilled chicken burger',
    category: 'Burgers',
    defaultPriceMinor: '1000',
  },
  {
    sku: 'PIZZA-01',
    name: 'Pizza',
    description: 'Margherita pizza',
    category: 'Pizza',
    defaultPriceMinor: '1500',
  },
  {
    sku: 'COLA-01',
    name: 'Cola',
    description: 'Chilled cola 330ml',
    category: 'Drinks',
    defaultPriceMinor: '300',
  },
];

const DEMO_OUTLETS: ReadonlyArray<{ code: string; name: string; id: string }> = [
  // Fixed demo UUIDs so docs, seeds, root .env (OUTLET_A_ID) and the outlet
  // database identity all agree — sync derives the outlet scope from them.
  { code: 'A', name: 'Outlet A', id: '11111111-1111-4111-8111-111111111111' },
  { code: 'B', name: 'Outlet B', id: '22222222-2222-4222-8222-222222222222' },
  { code: 'C', name: 'Outlet C', id: '33333333-3333-4333-8333-333333333333' },
];

async function seedCompany(dataSource: DataSource): Promise<CompanyEntity> {
  const repo = dataSource.getRepository(CompanyEntity);
  const existing = await repo.findOne({ where: {} });
  if (existing) {
    log('seed_company_exists', { companyId: existing.id });
    return existing;
  }
  const company = repo.create({
    name: process.env.SEED_COMPANY_NAME ?? 'F&B Platform',
    currencyCode: 'USD',
  });
  const saved = await repo.save(company);
  log('seed_company_created', { companyId: saved.id });
  return saved;
}

async function seedPermissions(dataSource: DataSource): Promise<Map<string, string>> {
  const repo = dataSource.getRepository(HqPermissionEntity);
  const byCode = new Map<string, string>();
  for (const code of HQ_PERMISSIONS) {
    const existing = await repo.findOne({ where: { code } });
    if (existing) {
      byCode.set(code, existing.id);
      continue;
    }
    const saved = await repo.save(repo.create({ code, description: '' }));
    byCode.set(code, saved.id);
  }
  log('seed_permissions_ready', { count: byCode.size });
  return byCode;
}

async function seedRoles(
  dataSource: DataSource,
  companyId: string,
  permissionIds: Map<string, string>,
): Promise<Map<string, string>> {
  const rolesRepo = dataSource.getRepository(HqRoleEntity);
  const rolePermsRepo = dataSource.getRepository(HqRolePermissionEntity);
  const roleIds = new Map<string, string>();

  for (const role of DEFAULT_HQ_ROLES) {
    let entity = await rolesRepo.findOne({ where: { companyId, code: role.code } });
    if (!entity) {
      entity = await rolesRepo.save(rolesRepo.create({ companyId, code: role.code, name: role.name }));
      log('seed_role_created', { code: role.code, roleId: entity.id });
    }
    roleIds.set(role.code, entity.id);

    // Keep the role → permission membership aligned with the catalog.
    for (const permission of role.permissions) {
      const permissionId = permissionIds.get(permission);
      if (!permissionId) continue;
      const existing = await rolePermsRepo.findOne({
        where: { roleId: entity.id, permissionId },
      });
      if (!existing) {
        await rolePermsRepo.save(rolePermsRepo.create({ roleId: entity.id, permissionId }));
      }
    }
  }
  return roleIds;
}

async function seedSuperAdmin(
  dataSource: DataSource,
  companyId: string,
  roleIds: Map<string, string>,
): Promise<void> {
  const usersRepo = dataSource.getRepository(HqUserEntity);
  const userRolesRepo = dataSource.getRepository(HqUserRoleEntity);
  const email = (process.env.SEED_HQ_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL).toLowerCase();
  const password = process.env.SEED_HQ_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;

  const existing = await usersRepo
    .createQueryBuilder('user')
    .where('user.company_id = :companyId AND lower(user.email) = :email', { companyId, email })
    .getOne();
  if (existing) {
    log('seed_admin_exists', { userId: existing.id });
    return;
  }

  const superAdminRoleId = roleIds.get('HQ_SUPER_ADMIN');
  if (!superAdminRoleId) throw new Error('HQ_SUPER_ADMIN role missing from seed catalog');

  const admin = await usersRepo.save(
    usersRepo.create({
      companyId,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      status: 'ACTIVE',
    }),
  );
  await userRolesRepo.save(userRolesRepo.create({ userId: admin.id, roleId: superAdminRoleId }));
  log('seed_admin_created', { userId: admin.id, email });
  if (!process.env.SEED_HQ_ADMIN_PASSWORD) {
    log('seed_admin_default_password', {
      warning: 'SEED_HQ_ADMIN_PASSWORD not set; local development default credentials in use',
    });
  }
}

async function seedDemoData(dataSource: DataSource, companyId: string): Promise<void> {
  // Demo outlets with their locked revision row (revision 0, PRD §6.1).
  const outletsRepo = dataSource.getRepository(OutletEntity);
  const revisionsRepo = dataSource.getRepository(OutletCatalogRevisionEntity);
  for (const demo of DEMO_OUTLETS) {
    const existing = await outletsRepo.findOne({ where: { companyId, code: demo.code } });
    if (existing) continue;
    const outlet = await outletsRepo.save(
      outletsRepo.create({ id: demo.id, companyId, code: demo.code, name: demo.name, timezone: 'UTC', status: 'ACTIVE' }),
    );
    await revisionsRepo.save(revisionsRepo.create({ outletId: outlet.id, currentRevision: '0' }));
    log('seed_outlet_created', { outletId: outlet.id, code: demo.code });
  }

  // Demo categories.
  const categoriesRepo = dataSource.getRepository(MenuCategoryEntity);
  const categoryIds = new Map<string, string>();
  for (const [index, name] of DEMO_CATEGORIES.entries()) {
    const existing = await categoriesRepo.findOne({ where: { companyId, name } });
    if (existing) {
      categoryIds.set(name, existing.id);
      continue;
    }
    const saved = await categoriesRepo.save(
      categoriesRepo.create({ companyId, name, sortOrder: index, status: 'ACTIVE' }),
    );
    categoryIds.set(name, saved.id);
    log('seed_category_created', { categoryId: saved.id, name });
  }

  // Demo master items (AT-01/AT-02 verification data).
  const itemsRepo = dataSource.getRepository(MasterMenuItemEntity);
  for (const item of DEMO_ITEMS) {
    const existing = await itemsRepo.findOne({ where: { companyId, sku: item.sku } });
    if (existing) continue;
    const categoryId = categoryIds.get(item.category);
    if (!categoryId) throw new Error(`seed category missing: ${item.category}`);
    const saved = await itemsRepo.save(
      itemsRepo.create({
        companyId,
        categoryId,
        sku: item.sku,
        name: item.name,
        description: item.description,
        defaultPriceMinor: item.defaultPriceMinor,
        currencyCode: 'USD',
        status: 'ACTIVE',
        version: 1,
      }),
    );
    log('seed_item_created', { itemId: saved.id, sku: item.sku });
  }
}

/**
 * Dev key-provisioning loop (PRD §9.2, V1): `SEED_ISSUE_OUTLET_KEYS=1`
 * issues one real scoped machine key per seeded outlet and prints
 * `keyId.secret` ONCE — the seed runs server-side with the pepper from the
 * environment, so the printed pair is the only place the raw secret exists.
 * Idempotent: outlets that already hold an ACTIVE, unexpired key are
 * skipped (rotation stays a deliberate admin action).
 */
async function seedOutletKeys(dataSource: DataSource): Promise<void> {
  const pepper = process.env.OUTLET_KEY_PEPPER;
  if (!pepper) {
    throw new Error('SEED_ISSUE_OUTLET_KEYS=1 requires OUTLET_KEY_PEPPER (must match hq-api)');
  }
  const outlets = await dataSource.getRepository(OutletEntity).find({ order: { code: 'ASC' } });
  const keysRepo = dataSource.getRepository(OutletApiKeyEntity);
  const auditRepo = dataSource.getRepository(AuditLogEntity);

  for (const outlet of outlets) {
    const existing = await keysRepo.findOne({
      where: { outletId: outlet.id, status: 'ACTIVE' },
      order: { createdAt: 'DESC' },
    });
    if (existing && (existing.expiresAt === null || existing.expiresAt.getTime() > Date.now())) {
      log('seed_outlet_key_skipped', { outletCode: outlet.code, existingKeyId: existing.keyId });
      continue;
    }
    const keyId = generateOutletKeyId(process.env.NODE_ENV ?? 'development');
    const secret = generateOutletKeySecret();
    await dataSource.transaction(async (manager) => {
      await manager.getRepository(OutletApiKeyEntity).insert(
        manager.getRepository(OutletApiKeyEntity).create({
          keyId,
          outletId: outlet.id,
          secretHash: hashOutletKeySecret(secret, pepper),
          scopes: [...OUTLET_KEY_SCOPES],
          status: 'ACTIVE',
          expiresAt: null,
          lastUsedAt: null,
          rotatedFromId: null,
        }),
      );
      const auditRow = manager.getRepository(AuditLogEntity).create({
        actorType: 'SYSTEM',
        actorId: null,
        action: 'outlet_key.issued',
        entityType: 'outlet_api_key',
        entityId: outlet.id,
        metadata: { outletId: outlet.id, keyId, scopes: [...OUTLET_KEY_SCOPES], via: 'seed' },
      });
      // jsonb column typing is a deep-partial mismatch for TypeORM's insert;
      // the row shape is exact by construction.
      await manager.getRepository(AuditLogEntity).insert(auditRow as never);
    });
    // One-time reveal — copy into the outlet worker's environment
    // (root .env: OUTLET_<CODE>_HQ_KEY_ID / _SECRET) and keep out of logs.
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: 'warn', service: 'hq-backend', msg: 'seed_outlet_key_issued', warning: 'SECRET SHOWN ONCE — store it now', outletCode: outlet.code, keyId, secret })}\n`,
    );
  }
}

async function main(): Promise<void> {
  const dataSource = buildCliDataSource();
  try {
    await dataSource.initialize();
    const company = await seedCompany(dataSource);
    const permissionIds = await seedPermissions(dataSource);
    const roleIds = await seedRoles(dataSource, company.id, permissionIds);
    await seedSuperAdmin(dataSource, company.id, roleIds);
    if ((process.env.SEED_DEMO_DATA ?? 'true').toLowerCase() !== 'false') {
      await seedDemoData(dataSource, company.id);
    }
    if ((process.env.SEED_ISSUE_OUTLET_KEYS ?? '') === '1') {
      await seedOutletKeys(dataSource);
    }
    log('seed_completed', { companyId: company.id });
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: 'hq-backend',
      msg: 'seed_failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
