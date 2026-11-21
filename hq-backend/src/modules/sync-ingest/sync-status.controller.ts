import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { OutletKeyGuard } from '../../common/auth/outlet-key.guard.js';
import {
  CurrentOutletKey,
  RequireKeyScopes,
  type OutletKeyIdentity,
} from '../../common/auth/require-key-scopes.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { HeartbeatRequest, HeartbeatResponse, SyncCheckpointResponse } from './dto/sync-status.dto.js';
import { HqSyncStatusService } from './hq-sync-status.service.js';

/**
 * Outlet sync diagnostics (PRD §7.4): the reconciliation checkpoint the
 * worker compares its outbox against, and the outbound heartbeat carrying
 * local backlog/menu-revision watermarks. A dedicated throttle budget
 * (600/min) keeps sync traffic clear of the human default (§7.4).
 */
@ApiTags('sync')
@ApiSecurity('outlet-key')
@Public()
@UseGuards(OutletKeyGuard)
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@Controller('sync/v1')
export class SyncStatusController {
  constructor(private readonly syncStatus: HqSyncStatusService) {}

  @Get('checkpoint')
  @RequireKeyScopes('events.push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Highest contiguous accepted sequence + missing ranges.' })
  @ApiOkResponse({ type: SyncCheckpointResponse })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — missing/invalid outlet key' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — key lacks the events.push scope' })
  async getCheckpoint(@CurrentOutletKey() key: OutletKeyIdentity): Promise<SyncCheckpointResponse> {
    return this.syncStatus.getCheckpoint(key.outletId);
  }

  @Post('heartbeat')
  @RequireKeyScopes('status.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Report local backlog and applied menu revision.' })
  @ApiOkResponse({ type: HeartbeatResponse })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — missing/invalid outlet key' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — key lacks the status.write scope' })
  async heartbeat(
    @CurrentOutletKey() key: OutletKeyIdentity,
    @Body() body: HeartbeatRequest,
  ): Promise<HeartbeatResponse> {
    const acknowledgedAt = await this.syncStatus.recordHeartbeat(key.outletId, body);
    return { acknowledgedAt };
  }
}
