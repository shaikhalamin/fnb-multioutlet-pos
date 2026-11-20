import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { HealthService, type HealthReport } from './health.service.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness/readiness probe (database + Redis)' })
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
