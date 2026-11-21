import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { SyncStatusResponse } from './dto/sync.dto.js';
import { SyncService } from './sync.service.js';

/**
 * Local sync status (PRD §7.3): menu revision, last sync, grace state and
 * outbox backlog — served entirely from local tables.
 */
@ApiTags('Sync')
@ApiSecurity('bearer-jwt')
@Controller()
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Get('sync/status')
  @RequirePermissions('sync.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Local menu-sync checkpoint and outbox backlog.' })
  @ApiOkResponse({ type: SyncStatusResponse })
  async getStatus(): Promise<SyncStatusResponse> {
    return this.syncService.getStatus();
  }
}
