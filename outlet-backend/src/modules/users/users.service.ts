import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import type { OutletUserStatus } from '../../database/entities/outlet-user.entity.js';
import { decodeCursor, UsersRepository } from './users.repository.js';
import type { CreateUserRequest, UpdateUserRequest } from './dto/user.request.js';
import type { UserResponse } from './dto/user.response.js';

const BCRYPT_ROUNDS = 12;

/**
 * Local outlet user administration (Phase 2 scope decision, PRD §3 persona
 * table): Outlet Manager manages this outlet's staff. User creation and role
 * membership writes commit atomically; passwords never leave the service and
 * responses expose no password material (PRD §9.1).
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly users: UsersRepository,
  ) {}

  async list(limit: number, cursor?: string): Promise<{ users: UserResponse[]; nextCursor: string | undefined }> {
    const page = await this.users.list(limit, decodeCursor(cursor));
    return { users: page.users.map(toUserResponse), nextCursor: page.nextCursor };
  }

  async create(request: CreateUserRequest): Promise<UserResponse> {
    const email = request.email.toLowerCase();

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ApiException('CONFLICT', 'A user with this email already exists.', 409, { email });
    }
    const roles = await this.resolveRoles(request.roleCodes);

    const created = await this.dataSource.transaction(async (manager) => {
      const user = await this.users.insertUser(manager, {
        email,
        passwordHash: await bcrypt.hash(request.password, BCRYPT_ROUNDS),
      });
      await this.users.setUserRoles(manager, user.id, roles.map((role) => role.id));
      return user;
    });

    return toUserResponse({
      id: created.id,
      email: created.email,
      status: created.status,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      roleCodes: roles.map((role) => role.code),
    });
  }

  async update(userId: string, request: UpdateUserRequest, actorId: string): Promise<UserResponse> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new ApiException('NOT_FOUND', 'User not found.', 404);
    }
    if (request.status === 'DISABLED' && user.id === actorId) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'You cannot disable your own account.', 422);
    }

    const roles = request.roleCodes
      ? await this.resolveRoles(request.roleCodes)
      : undefined;

    await this.dataSource.transaction(async (manager) => {
      if (request.status && request.status !== user.status) {
        await this.users.updateStatus(manager, user.id, request.status);
      }
      if (roles) {
        await this.users.setUserRoles(manager, user.id, roles.map((role) => role.id));
      }
    });

    const roleCodes = roles ? roles.map((role) => role.code) : await this.users.roleCodesOf(user.id);
    return toUserResponse({
      id: user.id,
      email: user.email,
      status: (request.status ?? user.status) as OutletUserStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      roleCodes,
    });
  }

  async listRoles(): Promise<
    Array<{ id: string; code: string; name: string; permissions: string[] }>
  > {
    return this.users.listRoles();
  }

  private async resolveRoles(codes: string[]) {
    const roles = await this.users.findRolesByCodes(codes);
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
