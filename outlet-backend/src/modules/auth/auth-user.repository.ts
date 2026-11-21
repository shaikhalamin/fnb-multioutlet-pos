import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletRoleEntity } from '../../database/entities/outlet-role.entity.js';
import { OutletUserEntity } from '../../database/entities/outlet-user.entity.js';
import { OutletUserRoleEntity } from '../../database/entities/outlet-user-role.entity.js';
import { OutletRolePermissionEntity } from '../../database/entities/outlet-role-permission.entity.js';
import { OutletPermissionEntity } from '../../database/entities/outlet-permission.entity.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';

/**
 * Identity lookups shared by the auth flow and the global JWT guard. Loads a
 * user together with role codes and the effective permission set (union over
 * all roles) so authorization always reflects current DB state (PRD §9.1).
 * `outletId` on the identity is the provisioned outlet from validated env
 * configuration (PRD §9.1 login example, §3): this database belongs to
 * exactly one outlet and identity never comes from request JSON.
 */
@Injectable()
export class AuthUserRepository {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async findByEmail(email: string): Promise<OutletUserEntity | null> {
    return this.dataSource
      .getRepository(OutletUserEntity)
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: email.toLowerCase() })
      .getOne();
  }

  async findById(userId: string): Promise<OutletUserEntity | null> {
    return this.dataSource.getRepository(OutletUserEntity).findOne({ where: { id: userId } });
  }

  async findActiveUserWithPermissions(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.dataSource.getRepository(OutletUserEntity).findOne({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE') return null;

    const [roleCodes, permissions] = await Promise.all([
      this.loadRoleCodes(userId),
      this.loadPermissions(userId),
    ]);
    return {
      id: user.id,
      email: user.email,
      roleCodes,
      permissions,
      outletId: this.config.get('OUTLET_ID', { infer: true }),
    };
  }

  private async loadRoleCodes(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('role.code', 'code')
      .from(OutletUserRoleEntity, 'user_role')
      .innerJoin(OutletRoleEntity, 'role', 'role.id = user_role.role_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }

  private async loadPermissions(userId: string): Promise<string[]> {
    const rows = await this.dataSource
      .createQueryBuilder()
      .select('DISTINCT permission.code', 'code')
      .from(OutletUserRoleEntity, 'user_role')
      .innerJoin(OutletRolePermissionEntity, 'role_permission', 'role_permission.role_id = user_role.role_id')
      .innerJoin(OutletPermissionEntity, 'permission', 'permission.id = role_permission.permission_id')
      .where('user_role.user_id = :userId', { userId })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }
}
