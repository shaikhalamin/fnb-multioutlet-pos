import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { HqRoleEntity } from '../../database/entities/hq-role.entity.js';
import { HqRolePermissionEntity } from '../../database/entities/hq-role-permission.entity.js';
import { HqUserEntity } from '../../database/entities/hq-user.entity.js';
import { HqUserRoleEntity } from '../../database/entities/hq-user-role.entity.js';
import { HqPermissionEntity } from '../../database/entities/hq-permission.entity.js';

export type UserWithRoles = HqUserEntity & { roleCodes: string[] };

export type ListUsersPage = { users: UserWithRoles[]; nextCursor: string | undefined };

/** Keyset pagination cursor over `(created_at, id)` descending. */
export type UserCursor = { createdAt: string; id: string };

/**
 * HQ user + role persistence (PRD §6.1). Role membership changes run inside
 * the caller's transaction; reads keyset-paginate on (created_at, id).
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(companyId: string, limit: number, cursor?: UserCursor): Promise<ListUsersPage> {
    const query = this.dataSource
      .getRepository(HqUserEntity)
      .createQueryBuilder('user')
      .where('user.company_id = :companyId', { companyId })
      .orderBy('user.created_at', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .take(limit + 1);
    if (cursor) {
      query.andWhere('(user.created_at, user.id) < (:createdAt, :id)', {
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      });
    }
    const rows = await query.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const users = await Promise.all(page.map((user) => this.attachRoleCodes(user)));
    const last = page.at(-1);
    return {
      users,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : undefined,
    };
  }

  async findById(companyId: string, userId: string): Promise<UserWithRoles | null> {
    const user = await this.dataSource
      .getRepository(HqUserEntity)
      .findOne({ where: { id: userId, companyId } });
    return user ? this.attachRoleCodes(user) : null;
  }

  async findByEmail(email: string): Promise<HqUserEntity | null> {
    return this.dataSource
      .getRepository(HqUserEntity)
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: email.toLowerCase() })
      .getOne();
  }

  async insertUser(
    manager: EntityManager,
    input: { companyId: string; email: string; passwordHash: string },
  ): Promise<HqUserEntity> {
    const repo = manager.getRepository(HqUserEntity);
    return repo.save(
      repo.create({ companyId: input.companyId, email: input.email.toLowerCase(), passwordHash: input.passwordHash, status: 'ACTIVE' }),
    );
  }

  async setUserRoles(manager: EntityManager, userId: string, roleIds: string[]): Promise<void> {
    const repo = manager.getRepository(HqUserRoleEntity);
    await repo.delete({ userId });
    if (roleIds.length > 0) {
      await repo.insert(roleIds.map((roleId) => ({ userId, roleId }) as HqUserRoleEntity));
    }
  }

  async updateStatus(manager: EntityManager, userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
    await manager.getRepository(HqUserEntity).update({ id: userId }, { status });
  }

  async listRoles(companyId: string): Promise<Array<HqRoleEntity & { permissions: string[] }>> {
    const roles = await this.dataSource
      .getRepository(HqRoleEntity)
      .find({ where: { companyId }, order: { code: 'ASC' } });
    return Promise.all(
      roles.map(async (role) => ({
        ...role,
        permissions: await this.loadRolePermissions(role.id),
      })),
    );
  }

  async findRolesByCodes(companyId: string, codes: string[]): Promise<HqRoleEntity[]> {
    if (codes.length === 0) return [];
    return this.dataSource
      .getRepository(HqRoleEntity)
      .createQueryBuilder('role')
      .where('role.company_id = :companyId AND role.code IN (:...codes)', { companyId, codes })
      .getMany();
  }

  async roleCodesOf(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('role.code', 'code')
      .from(HqUserRoleEntity, 'user_role')
      .innerJoin(HqRoleEntity, 'role', 'role.id = user_role.role_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }

  private async attachRoleCodes(user: HqUserEntity): Promise<UserWithRoles> {
    return { ...user, roleCodes: await this.roleCodesOf(user.id) };
  }

  private async loadRolePermissions(roleId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('permission.code', 'code')
      .from(HqRolePermissionEntity, 'role_permission')
      .innerJoin(HqPermissionEntity, 'permission', 'permission.id = role_permission.permission_id')
      .where('role_permission.role_id = :roleId', { roleId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }
}

export function encodeCursor(cursor: UserCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): UserCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as UserCursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
