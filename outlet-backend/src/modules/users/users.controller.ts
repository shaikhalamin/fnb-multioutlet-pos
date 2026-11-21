import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiPropertyOptional, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { withCursor } from '../../common/interceptors/envelope.interceptor.js';
import { CreateUserRequest, UpdateUserRequest } from './dto/user.request.js';
import { RoleResponse, UserResponse } from './dto/user.response.js';
import { UsersService } from './users.service.js';

export class ListUsersQuery {
  @ApiPropertyOptional({ example: 50, default: 50, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from meta.nextCursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * Local outlet user + role administration (Phase 2 scope decision).
 * Passwords never leave the service; responses expose no password material
 * (PRD §9.1).
 */
@ApiTags('Users')
@ApiSecurity('bearer-jwt')
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('users')
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'List local outlet users (keyset pagination).' })
  @ApiOkResponse({ type: [UserResponse] })
  async listUsers(@Query() query: ListUsersQuery): Promise<UserResponse[]> {
    const page = await this.usersService.list(query.limit ?? 50, query.cursor);
    return withCursor(page.users, page.nextCursor);
  }

  @Post('users')
  @RequirePermissions('users.write')
  @ApiOperation({ summary: 'Create a local outlet user with roles.' })
  @ApiCreatedResponse({ type: UserResponse })
  @ApiResponse({ status: 409, description: 'CONFLICT — email already exists' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY — unknown role code' })
  async createUser(@Body() body: CreateUserRequest): Promise<UserResponse> {
    return this.usersService.create(body);
  }

  @Patch('users/:id')
  @RequirePermissions('users.write')
  @ApiOperation({ summary: 'Update status and/or replace roles.' })
  @ApiOkResponse({ type: UserResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY' })
  async updateUser(
    @Param('id') id: string,
    @Body() body: UpdateUserRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.usersService.update(id, body, actor.id);
  }

  @Get('roles')
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'List local roles with their permission sets.' })
  @ApiOkResponse({ type: [RoleResponse] })
  async listRoles(): Promise<RoleResponse[]> {
    return this.usersService.listRoles();
  }
}
