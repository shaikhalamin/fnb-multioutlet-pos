import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { RevenueByOutletQuery, RevenueByOutletResponse } from './dto/report.dto.js';
import { ReportingService } from './reporting.service.js';

/**
 * Cross-outlet reporting (PRD §7.2, §10): read-only aggregations over the HQ
 * projections with explicit staleness disclosure (`dataAsOf`,
 * `isProvisional`, per-outlet watermarks — AT-20).
 */
@ApiTags('Reports')
@ApiSecurity('bearer-jwt')
@Controller('reports')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get('revenue-by-outlet')
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: 'Completed revenue per outlet for a UTC window (PRD §10).' })
  @ApiOkResponse({ type: RevenueByOutletResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — malformed or out-of-range report window' })
  async revenueByOutlet(@Query() query: RevenueByOutletQuery): Promise<RevenueByOutletResponse> {
    return this.reportingService.revenueByOutlet(query);
  }
}
