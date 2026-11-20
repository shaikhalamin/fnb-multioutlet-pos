import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { CreateOutletRequest, OutletResponse, UpdateOutletRequest } from './dto/outlet.dto.js';
import { OutletsService } from './outlets.service.js';

/** Outlet lifecycle (PRD §7.2). */
@ApiTags('Outlets')
@ApiSecurity('bearer-jwt')
@Controller('outlets')
export class OutletsController {
  constructor(private readonly outletsService: OutletsService) {}

  @Get()
  @RequirePermissions('outlets.read')
  @ApiOperation({ summary: 'List outlets with their current catalog revision.' })
  @ApiOkResponse({ type: [OutletResponse] })
  async listOutlets(): Promise<OutletResponse[]> {
    return this.outletsService.list();
  }

  @Post()
  @RequirePermissions('outlets.write')
  @ApiOperation({ summary: 'Provision an outlet (creates its revision-0 catalog row).' })
  @ApiCreatedResponse({ type: OutletResponse })
  @ApiResponse({ status: 409, description: 'CONFLICT — duplicate outlet code' })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY — bad timezone' })
  async createOutlet(
    @Body() body: CreateOutletRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<OutletResponse> {
    return this.outletsService.create(body, actor.id);
  }

  @Patch(':id')
  @RequirePermissions('outlets.write')
  @ApiOperation({ summary: 'Rename or suspend/reactivate an outlet.' })
  @ApiOkResponse({ type: OutletResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async updateOutlet(
    @Param('id') id: string,
    @Body() body: UpdateOutletRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<OutletResponse> {
    return this.outletsService.update(id, body, actor.id);
  }
}
