import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
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
import {
  ExtendGraceRequest,
  GraceOverrideResponse,
  ReplayOutboxEventResponse,
  SyncStatusResponse,
} from './dto/sync.dto.js';
import { SyncService } from './sync.service.js';

/**
 * Local sync surface (PRD §7.3, §8.5, §8.8): status reads from local tables,
 * plus the privileged, audited emergency actions — offline-grace override
 * and quarantined-event replay (`sync.override`, outlet managers only).
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
