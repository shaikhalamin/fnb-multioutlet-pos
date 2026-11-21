import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletRoleEntity } from '../../database/entities/outlet-role.entity.js';
import { OutletRolePermissionEntity } from '../../database/entities/outlet-role-permission.entity.js';
import { OutletUserEntity } from '../../database/entities/outlet-user.entity.js';
import { OutletUserRoleEntity } from '../../database/entities/outlet-user-role.entity.js';
import { OutletPermissionEntity } from '../../database/entities/outlet-permission.entity.js';

/** Plain-object projection of a user row plus its role codes. */
export type UserWithRoles = {
  id: string;
  email: string;
  passwordHash: string;
  status: OutletUserEntity['status'];
  createdAt: Date;
  updatedAt: Date;
  roleCodes: string[];
};

export type ListUsersPage = { users: UserWithRoles[]; nextCursor: string | undefined };

/** Keyset pagination cursor over `(created_at, id)` descending. */
export type UserCursor = { createdAt: string; id: string };

/**
 * Outlet user + role persistence (PRD §6.2). Role membership changes run
 * inside the caller's transaction; reads keyset-paginate on (created_at, id).
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(limit: number, cursor?: UserCursor): Promise<ListUsersPage> {
    const query = this.dataSource
      .getRepository(OutletUserEntity)
      .createQueryBuilder('user')
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

  async findById(userId: string): Promise<UserWithRoles | null> {
    const user = await this.dataSource.getRepository(OutletUserEntity).findOne({ where: { id: userId } });
    return user ? this.attachRoleCodes(user) : null;
  }

  private async attachRoleCodes(user: OutletUserEntity): Promise<UserWithRoles> {
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roleCodes: await this.roleCodesOf(user.id),
    };
  }

  async findByEmail(email: string): Promise<OutletUserEntity | null> {
    return this.dataSource
      .getRepository(OutletUserEntity)
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: email.toLowerCase() })
      .getOne();
  }

  async insertUser(
    manager: EntityManager,
    input: { email: string; passwordHash: string },
  ): Promise<OutletUserEntity> {
    const repo = manager.getRepository(OutletUserEntity);
    return repo.save(
      repo.create({ email: input.email.toLowerCase(), passwordHash: input.passwordHash, status: 'ACTIVE' }),
    );
  }

  async setUserRoles(manager: EntityManager, userId: string, roleIds: string[]): Promise<void> {
    const repo = manager.getRepository(OutletUserRoleEntity);
    await repo.delete({ userId });
    if (roleIds.length > 0) {
      await repo.insert(roleIds.map((roleId) => ({ userId, roleId }) as OutletUserRoleEntity));
    }
  }

  async updateStatus(manager: EntityManager, userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
    await manager.getRepository(OutletUserEntity).update({ id: userId }, { status });
  }

  async listRoles(): Promise<Array<{ id: string; code: string; name: string; createdAt: Date; permissions: string[] }>> {
    const roles = await this.dataSource
      .getRepository(OutletRoleEntity)
      .find({ order: { code: 'ASC' } });
    return Promise.all(
      roles.map(async (role) => ({
        id: role.id,
        code: role.code,
        name: role.name,
        createdAt: role.createdAt,
        permissions: await this.loadRolePermissions(role.id),
      })),
    );
  }

  async findRolesByCodes(codes: string[]): Promise<OutletRoleEntity[]> {
    if (codes.length === 0) return [];
    return this.dataSource
      .getRepository(OutletRoleEntity)
      .createQueryBuilder('role')
      .where('role.code IN (:...codes)', { codes })
      .getMany();
  }

  async roleCodesOf(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('role.code', 'code')
      .from(OutletUserRoleEntity, 'user_role')
      .innerJoin(OutletRoleEntity, 'role', 'role.id = user_role.role_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }

  private async loadRolePermissions(roleId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('permission.code', 'code')
      .from(OutletRolePermissionEntity, 'role_permission')
      .innerJoin(OutletPermissionEntity, 'permission', 'permission.id = role_permission.permission_id')
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
  // A present-but-undecodable cursor is a client bug: reject it loudly
  // instead of silently restarting at page 1 (duplicate rows for the user).
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as UserCursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new ApiException('VALIDATION_FAILED', 'Malformed pagination cursor.', 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiException) throw error;
    throw new ApiException('VALIDATION_FAILED', 'Malformed pagination cursor.', 400);
  }
}
