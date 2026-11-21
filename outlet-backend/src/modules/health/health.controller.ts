import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { Public } from '../../common/auth/public.decorator.js';
import { HealthResponse } from './dto/health.response.js';
import { HealthService, type HealthReport } from './health.service.js';

@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  // Liveness probes must never be throttled (and must not consume budget).
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness/readiness probe (database + Redis)' })
  @ApiOkResponse({ type: HealthResponse })
  async getHealth(): Promise<HealthReport> {
    const report = await this.healthService.check();
    if (report.status === 'down') {
      throw new ApiException('SERVICE_UNAVAILABLE', 'One or more health checks are failing.', 503, {
        checks: report.checks,
      });
    }
    return report;
  }
}
