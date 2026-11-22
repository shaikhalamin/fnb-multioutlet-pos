import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { HqConnectionResponse, SaveHqConnectionRequest } from '../setup/dto/setup.dto.js';
// Value import (not `import type`): the class is an injection token.
import { SetupService } from '../setup/setup.service.js';
import {
  ExtendGraceRequest,
  GraceOverrideResponse,
  ReplayOutboxEventResponse,
  SyncStatusResponse,
} from './dto/sync.dto.js';
import { SyncService } from './sync.service.js';

/**
 * Local sync surface (PRD §7.3, §8.5, §8.8): status reads from local tables,
 * the privileged, audited emergency actions — offline-grace override and
 * quarantined-event replay (`sync.override`, outlet managers only) — and the
 * authenticated HQ key rotation path (`sync.manage`, managers only; setup
 * itself seals permanently after first pairing).
 */
@ApiTags('Sync')
@ApiSecurity('bearer-jwt')
@Controller()
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly setupService: SetupService,
  ) {}

  @Get('sync/status')
  @RequirePermissions('sync.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Local menu-sync checkpoint and outbox backlog.' })
  @ApiOkResponse({ type: SyncStatusResponse })
  async getStatus(): Promise<SyncStatusResponse> {
    return this.syncService.getStatus();
  }

  @Put('sync/hq-connection')
  @RequirePermissions('sync.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the stored HQ machine key (validated against HQ before saving).' })
  @ApiOkResponse({ type: HqConnectionResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — HQ rejected the key or it belongs to another outlet' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — requires sync.manage' })
  @ApiResponse({ status: 409, description: 'CONFLICT — terminal not paired yet' })
  @ApiResponse({ status: 503, description: 'SYNC_TEMPORARILY_UNAVAILABLE — HQ unreachable' })
  async updateHqConnection(
    @Body() body: SaveHqConnectionRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<HqConnectionResponse> {
    return this.setupService.updateHqConnection(body, { id: actor.id, email: actor.email });
  }

  @Post('sync/grace-override')
  @RequirePermissions('sync.override')
  @HttpCode(200)
  @ApiOperation({ summary: 'Extend the offline grace window (privileged, audited — PRD §8.8).' })
  @ApiOkResponse({ type: GraceOverrideResponse })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — requires sync.override (AT-17 flavor)' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — menu sync state missing' })
  async extendGrace(
    @Body() body: ExtendGraceRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<GraceOverrideResponse> {
    return this.syncService.extendGrace(body, { id: actor.id, email: actor.email });
  }

  @Post('sync/outbox/:eventId/replay')
  @RequirePermissions('sync.override')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-arm a quarantined outbox event after operator review (§8.5).' })
  @ApiOkResponse({ type: ReplayOutboxEventResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — event does not exist' })
  @ApiResponse({ status: 409, description: 'CONFLICT — event is not QUARANTINED' })
  async replayEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ReplayOutboxEventResponse> {
    return this.syncService.replayQuarantinedEvent(eventId, { id: actor.id });
  }
}
