import bcrypt from 'bcrypt';
import type { EntityManager } from 'typeorm';
import { DEFAULT_OUTLET_ROLES, OUTLET_PERMISSIONS } from '../../common/rbac/permissions.js';
import { MenuSyncStateEntity } from '../../database/entities/menu-sync-state.entity.js';
import { OutboxCounterEntity } from '../../database/entities/outbox-counter.entity.js';
import { OutletPermissionEntity } from '../../database/entities/outlet-permission.entity.js';
import { OutletRoleEntity } from '../../database/entities/outlet-role.entity.js';
import { OutletRolePermissionEntity } from '../../database/entities/outlet-role-permission.entity.js';
import { OutletUserEntity } from '../../database/entities/outlet-user.entity.js';
import { OutletUserRoleEntity } from '../../database/entities/outlet-user-role.entity.js';
import { ReceiptCounterEntity } from '../../database/entities/receipt-counter.entity.js';

const BCRYPT_ROUNDS = 12;

/**
 * Shared provisioning helpers (PRD §6.2 bootstrap): one code path for the
 * permission catalog, default roles, staff accounts and per-outlet
 * counters — used by BOTH the dev seed CLI and the setup wizard's single
 * transaction, so a UI-provisioned terminal gets exactly what a seeded one
 * gets. Every function is idempotent (natural-key find-or-create) and every
 * write joins the caller's transaction.
 */
export async function ensurePermissionsAndRoles(manager: EntityManager): Promise<Map<string, string>> {
  const permissionsRepo = manager.getRepository(OutletPermissionEntity);
  const rolesRepo = manager.getRepository(OutletRoleEntity);
  const rolePermsRepo = manager.getRepository(OutletRolePermissionEntity);
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

  const roleIds = new Map<string, string>();
  for (const role of DEFAULT_OUTLET_ROLES) {
    let entity = await rolesRepo.findOne({ where: { code: role.code } });
    if (!entity) {
      entity = await rolesRepo.save(rolesRepo.create({ code: role.code, name: role.name }));
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

/** Find-or-create a staff account (case-insensitive email) with role links. */
export async function ensureUserWithRoles(
  manager: EntityManager,
  input: { email: string; password: string; roleId: string },
  rounds = BCRYPT_ROUNDS,
): Promise<{ created: boolean; email: string }> {
  const usersRepo = manager.getRepository(OutletUserEntity);
  const userRolesRepo = manager.getRepository(OutletUserRoleEntity);
  const email = input.email.toLowerCase();

  const existing = await usersRepo
    .createQueryBuilder('user')
    .where('lower(user.email) = :email', { email })
    .getOne();
  if (existing) return { created: false, email };

  const user = await usersRepo.save(
    usersRepo.create({ email, passwordHash: await bcrypt.hash(input.password, rounds), status: 'ACTIVE' }),
  );
  await userRolesRepo.save(userRolesRepo.create({ userId: user.id, roleId: input.roleId }));
  return { created: true, email };
}

/** Receipt (`<code>-000001`) and outbox sequence counters. */
export async function ensureCounters(
  manager: EntityManager,
  outletId: string,
  outletCode: string,
): Promise<void> {
  const receiptsRepo = manager.getRepository(ReceiptCounterEntity);
  if (!(await receiptsRepo.findOne({ where: { outletId } }))) {
    await receiptsRepo.insert(receiptsRepo.create({ outletId, nextNumber: '1', prefix: outletCode }));
  }
  const outboxRepo = manager.getRepository(OutboxCounterEntity);
  if (!(await outboxRepo.findOne({ where: { outletId } }))) {
    await outboxRepo.insert(outboxRepo.create({ outletId, nextSequence: '1' }));
  }
}

/**
 * Fresh menu-sync checkpoint at the given revision: anchors the offline
 * grace window (PRD §8.8) from the provisioning moment until the first pull.
 */
export async function ensureSyncState(
  manager: EntityManager,
  outletId: string,
  lastAppliedRevision: string,
): Promise<void> {
  const syncStateRepo = manager.getRepository(MenuSyncStateEntity);
  if (!(await syncStateRepo.findOne({ where: { outletId } }))) {
    await syncStateRepo.insert(
      syncStateRepo.create({
        outletId,
        lastAppliedRevision,
        lastSyncAt: new Date(),
        snapshotId: null,
      }),
    );
  }
}
