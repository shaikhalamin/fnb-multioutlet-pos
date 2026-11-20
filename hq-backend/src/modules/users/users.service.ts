import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import type { HqUserStatus } from '../../database/entities/hq-user.entity.js';
import { AuditService } from '../audit/audit.service.js';
import {
  decodeCursor,
  UsersRepository,
} from './users.repository.js';
import type { CreateUserRequest, UpdateUserRequest } from './dto/user.request.js';
import type { UserResponse } from './dto/user.response.js';

const BCRYPT_ROUNDS = 12;

/**
 * HQ user administration (PRD §3, Phase 1 scope decision: full CRUD). Role
 * membership and status changes commit atomically with their audit rows.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
  ) {}

  async list(limit: number, cursor?: string): Promise<{ users: UserResponse[]; nextCursor: string | undefined }> {
    const companyId = await resolveCompanyId(this.dataSource);
    const page = await this.users.list(companyId, limit, decodeCursor(cursor));
    return { users: page.users.map(toUserResponse), nextCursor: page.nextCursor };
  }

  async create(request: CreateUserRequest, actorId: string): Promise<UserResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const email = request.email.toLowerCase();

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ApiException('CONFLICT', 'A user with this email already exists.', 409, { email });
    }
    const roles = await this.resolveRoles(companyId, request.roleCodes);

    const created = await this.dataSource.transaction(async (manager) => {
      const user = await this.users.insertUser(manager, {
        companyId,
        email,
        passwordHash: await bcrypt.hash(request.password, BCRYPT_ROUNDS),
      });
      await this.users.setUserRoles(manager, user.id, roles.map((role) => role.id));
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'user.created',
          entityType: 'hq_user',
          entityId: user.id,
          metadata: { email, roleCodes: request.roleCodes },
        },
        manager,
      );
      return user;
    });

    return toUserResponse({ ...created, roleCodes: roles.map((role) => role.code) });
  }

  async update(userId: string, request: UpdateUserRequest, actorId: string): Promise<UserResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const user = await this.users.findById(companyId, userId);
    if (!user) {
      throw new ApiException('NOT_FOUND', 'User not found.', 404);
    }
    if (request.status === 'DISABLED' && user.id === actorId) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'You cannot disable your own account.', 422);
    }

    const roles = request.roleCodes
      ? await this.resolveRoles(companyId, request.roleCodes)
      : undefined;

    await this.dataSource.transaction(async (manager) => {
      if (request.status && request.status !== user.status) {
        await this.users.updateStatus(manager, user.id, request.status);
      }
      if (roles) {
        await this.users.setUserRoles(manager, user.id, roles.map((role) => role.id));
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'user.updated',
          entityType: 'hq_user',
          entityId: user.id,
          metadata: {
            status: request.status,
            roleCodes: roles ? roles.map((role) => role.code) : undefined,
          },
        },
        manager,
      );
    });

    const roleCodes = roles ? roles.map((role) => role.code) : await this.users.roleCodesOf(user.id);
    return toUserResponse({
      ...user,
      status: (request.status ?? user.status) as HqUserStatus,
      roleCodes,
    });
  }

  async listRoles(): Promise<
    Array<{ id: string; code: string; name: string; permissions: string[] }>
  > {
    const companyId = await resolveCompanyId(this.dataSource);
    return this.users.listRoles(companyId);
  }

  private async resolveRoles(companyId: string, codes: string[]) {
    const roles = await this.users.findRolesByCodes(companyId, codes);
    const found = new Set(roles.map((role) => role.code));
    const missing = codes.filter((code) => !found.has(code));
    if (missing.length > 0) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Unknown role codes.', 422, { unknownRoleCodes: missing });
    }
    return roles;
  }
}

function toUserResponse(user: {
  id: string;
  email: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  roleCodes: string[];
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    roleCodes: user.roleCodes,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
