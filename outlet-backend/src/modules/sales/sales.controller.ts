import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
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
import { ApiException } from '../../common/exceptions/api.exception.js';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { getRequestId } from '../../common/logging/request-context.js';
import { withCursor } from '../../common/interceptors/envelope.interceptor.js';
import { CreateSaleRequest, ListSalesQuery, SaleResponse, SaleSummaryResponse } from './dto/sale.dto.js';
import { SalesService } from './sales.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Local sale routes (PRD §7.3): the idempotent atomic sale plus local
 * history/receipt reads. Prices, totals, receipts, `soldAt` and outlet
 * identity are server-computed only (root AGENTS §5).
 */
@ApiTags('Sales')
@ApiSecurity('bearer-jwt')
@Controller()
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post('sales')
  @RequirePermissions('sales.create')
  @ApiOperation({
    summary: 'Create an atomic multi-item sale (requires an Idempotency-Key header).',
  })
  @ApiCreatedResponse({ type: SaleResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — missing/invalid Idempotency-Key or body' })
  @ApiResponse({ status: 409, description: 'INSUFFICIENT_STOCK / IDEMPOTENCY_KEY_REUSED' })
  @ApiResponse({ status: 422, description: 'ITEM_NOT_ASSIGNED / ITEM_INACTIVE' })
  @ApiResponse({ status: 503, description: 'SYNC_TEMPORARILY_UNAVAILABLE — offline grace expired' })
  async createSale(
    @Body() body: CreateSaleRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<SaleResponse> {
    // Header parsing, not business logic: the key is required and bounded.
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'The Idempotency-Key header is required (8-128 of [A-Za-z0-9_.:-]).',
        400,
      );
    }
    return this.salesService.createSale(body, {
      idempotencyKey,
      user,
      requestId: getRequestId() ?? (request.headers['x-request-id'] as string | undefined) ?? null,
    });
  }

  @Get('sales')
  @RequirePermissions('sales.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Local sale history (keyset pagination, optional from/to).' })
  @ApiOkResponse({ type: [SaleSummaryResponse] })
  async listSales(@Query() query: ListSalesQuery): Promise<SaleSummaryResponse[]> {
    const page = await this.salesService.listSales(
      query.limit ?? 50,
      { from: query.from, to: query.to },
      query.cursor,
    );
    return withCursor(page.sales, page.nextCursor);
  }

  @Get('sales/:id')
  @RequirePermissions('sales.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receipt detail with immutable line snapshots and sync status.' })
  @ApiOkResponse({ type: SaleResponse })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async getSale(@Param('id') id: string): Promise<SaleResponse> {
    return this.salesService.getSale(id);
  }
}
