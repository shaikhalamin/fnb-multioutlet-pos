import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import {
  IssueOutletKeyRequest,
  IssueOutletKeyResponse,
  OutletApiKeyResponse,
  RotateOutletKeyRequest,
} from './dto/api-key.dto.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * Outlet machine-key lifecycle (PRD §7.2, §9.2). The raw secret is returned
 * by issuance/rotation exactly once and never in list responses.
 */
@ApiTags('Outlet API Keys')
@ApiSecurity('bearer-jwt')
@Controller('outlets/:outletId/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  @RequirePermissions('keys.manage')
  @ApiOperation({ summary: 'Issue an outlet sync key; the secret is revealed once.' })
  @ApiCreatedResponse({ type: IssueOutletKeyResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async issue(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() body: IssueOutletKeyRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<IssueOutletKeyResponse> {
    return this.apiKeysService.issue(outletId, body, { type: 'USER', id: actor.id });
  }

  @Get()
  @RequirePermissions('keys.manage')
  @ApiOperation({ summary: 'List outlet keys (no secret material).' })
  @ApiOkResponse({ type: [OutletApiKeyResponse] })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async list(@Param('outletId', ParseUUIDPipe) outletId: string): Promise<OutletApiKeyResponse[]> {
    return this.apiKeysService.list(outletId);
  }

  @Post(':keyId/rotate')
  @RequirePermissions('keys.manage')
  @ApiOperation({ summary: 'Rotate a key; predecessor stays valid for the grace window.' })
  @ApiCreatedResponse({ type: IssueOutletKeyResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'CONFLICT — key not ACTIVE' })
  async rotate(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Param('keyId') keyId: string,
    @Body() body: RotateOutletKeyRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<IssueOutletKeyResponse> {
    return this.apiKeysService.rotate(outletId, keyId, body, actor.id);
  }

  @Delete(':keyId')
  @RequirePermissions('keys.manage')
  @ApiOperation({ summary: 'Revoke a key immediately.' })
  @ApiResponse({ status: 200, description: 'Revoked (idempotent).' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async revoke(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Param('keyId') keyId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ success: boolean }> {
    await this.apiKeysService.revoke(outletId, keyId, actor.id);
    return { success: true };
  }
}
