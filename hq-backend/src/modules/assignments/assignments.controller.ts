import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { BULK_ASSIGN_MAX_ITEMS } from './dto/assignment.dto.js';
import {
  AssignMenuItemsRequest,
  AssignMenuItemsResponse,
  AssignMenuRequest,
  AssignmentResponse,
  OutletMenuResponse,
} from './dto/assignment.dto.js';
import { AssignmentsService } from './assignments.service.js';

/** Outlet assignment + override editor endpoints (PRD §7.2, FR-02). */
@ApiTags('Assignments')
@ApiSecurity('bearer-jwt')
@Controller('outlets/:outletId/menu')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post()
  @RequirePermissions('assignments.write')
  @ApiOperation({
    summary: `Assign up to ${BULK_ASSIGN_MAX_ITEMS} items to an outlet atomically (one transaction).`,
  })
  @ApiCreatedResponse({ type: AssignMenuItemsResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — empty, duplicated or too many item lines, or a malformed price override' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — outlet, or one or more items' })
  @ApiResponse({ status: 422, description: 'ITEM_INACTIVE — an archived item; nothing is committed' })
  async assignMany(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() body: AssignMenuItemsRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AssignMenuItemsResponse> {
    return this.assignmentsService.assignMany(outletId, body.items, actor.id);
  }

  @Put(':itemId')
  @RequirePermissions('assignments.write')
  @ApiOperation({ summary: 'Assign/activate an item for an outlet, optionally overriding the price.' })
  @ApiOkResponse({ type: AssignmentResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — outlet or item' })
  @ApiResponse({ status: 422, description: 'ITEM_INACTIVE — archived item cannot be activated' })
  async assign(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: AssignMenuRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.assign(outletId, itemId, body, actor.id);
  }

  @Delete(':itemId')
  @RequirePermissions('assignments.write')
  @ApiOperation({ summary: 'Soft-unassign an item and emit its REMOVE revision.' })
  @ApiOkResponse({ type: AssignmentResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async unassign(
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AssignmentResponse> {
    return this.assignmentsService.unassign(outletId, itemId, actor.id);
  }

  @Get()
  @RequirePermissions('assignments.read')
  @ApiOperation({ summary: 'Assignment matrix rows for one outlet (HQ view).' })
  @ApiOkResponse({ type: [OutletMenuResponse] })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async listOutletMenu(
    @Param('outletId', ParseUUIDPipe) outletId: string,
  ): Promise<OutletMenuResponse[]> {
    return this.assignmentsService.listOutletMenu(outletId);
  }
}
