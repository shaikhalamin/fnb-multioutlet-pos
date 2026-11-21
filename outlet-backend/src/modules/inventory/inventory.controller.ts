import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { requestIdOf } from '../../common/utils/ids.js';
import {
  AdjustInventoryRequest,
  AdjustInventoryResponse,
  InventoryBalanceResponse,
} from './dto/inventory.dto.js';
import { InventoryService } from './inventory.service.js';

/**
 * Local inventory routes (PRD §7.3): balance list + audited adjustments.
 * Adjustments record the acting user and the request ID for the audit trail.
 */
@ApiTags('Inventory')
@ApiSecurity('bearer-jwt')
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('inventory')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Local stock balances joined with catalog identity.' })
  @ApiOkResponse({ type: [InventoryBalanceResponse] })
  async listBalances(): Promise<InventoryBalanceResponse[]> {
    return this.inventoryService.listBalances();
  }

  @Post('inventory/adjustments')
  @RequirePermissions('inventory.adjust')
  @HttpCode(200)
  @ApiOperation({ summary: 'Audited stock adjustment (RESTOCK / WRITE_OFF / RECOUNT).' })
  @ApiOkResponse({ type: AdjustInventoryResponse })
  @ApiResponse({ status: 422, description: 'UNPROCESSABLE_ENTITY / ITEM_NOT_ASSIGNED / INSUFFICIENT_STOCK' })
  async adjust(
    @Body() body: AdjustInventoryRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<AdjustInventoryResponse> {
    return this.inventoryService.adjust(body, {
      userId: user.id,
      requestId: requestIdOf(request),
    });
  }
}
