import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { HqRoleEntity } from '../../database/entities/hq-role.entity.js';
import { HqUserEntity } from '../../database/entities/hq-user.entity.js';
import { HqUserRoleEntity } from '../../database/entities/hq-user-role.entity.js';
import { HqRolePermissionEntity } from '../../database/entities/hq-role-permission.entity.js';
import { HqPermissionEntity } from '../../database/entities/hq-permission.entity.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';

/**
 * Identity lookups shared by the auth flow and the global JWT guard. Loads a
 * user together with role codes and the effective permission set (union over
 * all roles) so authorization always reflects current DB state (PRD §9.1).
 */
@Injectable()
export class AuthUserRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async findByEmail(email: string): Promise<HqUserEntity | null> {
    return this.dataSource
      .getRepository(HqUserEntity)
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: email.toLowerCase() })
      .getOne();
  }

  async findActiveUserWithPermissions(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.dataSource.getRepository(HqUserEntity).findOne({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') return null;

    const [roleCodes, permissions] = await Promise.all([
      this.loadRoleCodes(userId),
      this.loadPermissions(userId),
    ]);
    return { id: user.id, email: user.email, roleCodes, permissions };
  }

  private async loadRoleCodes(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('role.code', 'code')
      .from(HqUserRoleEntity, 'user_role')
      .innerJoin(HqRoleEntity, 'role', 'role.id = user_role.role_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }

  private async loadPermissions(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('DISTINCT permission.code', 'code')
      .from(HqUserRoleEntity, 'user_role')
      .innerJoin(HqRolePermissionEntity, 'role_permission', 'role_permission.role_id = user_role.role_id')
      .innerJoin(HqPermissionEntity, 'permission', 'permission.id = role_permission.permission_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }
}
