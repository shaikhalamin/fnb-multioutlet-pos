import { Controller, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { OutletKeyGuard } from '../../common/auth/outlet-key.guard.js';
import {
  CurrentOutletKey,
  RequireKeyScopes,
  type OutletKeyIdentity,
} from '../../common/auth/require-key-scopes.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import {
  CatalogChangesResponse,
  ListMenuChangesQuery,
  MenuSnapshotResponse,
} from './dto/menu-sync.dto.js';
import { MenuSyncService } from './menu-sync.service.js';

/**
 * Outlet menu pull (PRD §7.4, §8.3) — machine-key routes under `/sync/v1`.
 * Identity is derived exclusively from the key record; a dedicated throttle
 * budget (600/min) keeps catch-up pulls clear of the human default (§7.4).
 */
@ApiTags('sync')
@ApiSecurity('outlet-key')
@Public()
@UseGuards(OutletKeyGuard)
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@Controller('sync/v1/menu')
export class MenuPullController {
  constructor(private readonly menuSync: MenuSyncService) {}

  @Get('changes')
  @RequireKeyScopes('menu.pull')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revisioned catalog deltas for the authenticated outlet (ascending).' })
  @ApiOkResponse({ type: CatalogChangesResponse })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — missing/invalid outlet key' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — key lacks the menu.pull scope' })
  async getChanges(
    @CurrentOutletKey() key: OutletKeyIdentity,
    @Query() query: ListMenuChangesQuery,
  ): Promise<CatalogChangesResponse> {
    return this.menuSync.getChanges(key.outletId, query.afterRevision ?? '0', query.limit ?? 500);
  }

  @Get('snapshot')
  @RequireKeyScopes('menu.pull')
  @HttpCode(200)
  @ApiOperation({ summary: 'Consistent full catalog snapshot for bootstrap/gap recovery.' })
  @ApiOkResponse({ type: MenuSnapshotResponse })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — missing/invalid outlet key' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — key lacks the menu.pull scope' })
  async getSnapshot(@CurrentOutletKey() key: OutletKeyIdentity): Promise<MenuSnapshotResponse> {
    return this.menuSync.getSnapshot(key.outletId);
  }
}
