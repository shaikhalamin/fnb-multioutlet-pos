import { Controller, Get, HttpCode, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { HqSyncStatusService } from './hq-sync-status.service.js';
import { OutletSyncStatusResponse } from './dto/sync-status.dto.js';

/**
 * Human sync observability (PRD §7.2, FR-10): `GET /outlets/:id/sync-status`
 * for HQ staff. Lives with the sync module because it reads the sync-owned
 * checkpoint tables; it is a plain JWT route — the machine key guard never
 * applies here, and vice versa (§9.2). Cross-outlet scope is enforced by the
 * `sync.read` permission (HQ staff see all outlets).
 */
@ApiTags('Outlets')
@ApiSecurity('bearer-jwt')
@Controller('outlets')
export class SyncAdminController {
  constructor(private readonly syncStatus: HqSyncStatusService) {}

  @Get(':id/sync-status')
  @RequirePermissions('sync.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Outbox replication status known to HQ (FR-10).' })
  @ApiOkResponse({ type: OutletSyncStatusResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — outlet does not exist' })
  async getSyncStatus(@Param('id', ParseUUIDPipe) id: string): Promise<OutletSyncStatusResponse> {
    return this.syncStatus.getOutletSyncStatus(id);
  }
}
