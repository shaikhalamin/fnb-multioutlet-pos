import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/rbac/require-permissions.decorator.js';
import { withCursor } from '../../common/interceptors/envelope.interceptor.js';
import { AuditLogResponse, ListAuditLogsQuery } from './dto/audit.dto.js';
import { AuditReadService } from './audit-read.service.js';

/**
 * HQ audit views (PRD §11, FR-10): read-only, cursor-paginated access to the
 * immutable trail. `audit.read` is HQ_SUPER_ADMIN-only (§9.3 — analysts and
 * menu managers have no audit row).
 */
@ApiTags('Audit')
@ApiSecurity('bearer-jwt')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditRead: AuditReadService) {}

  @Get('logs')
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'List audit log entries (newest first, keyset pagination).' })
  @ApiOkResponse({ type: [AuditLogResponse] })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED — malformed filters, out-of-range limit, or invalid cursor',
  })
  async listLogs(@Query() query: ListAuditLogsQuery): Promise<AuditLogResponse[]> {
    const page = await this.auditRead.list(query);
    return withCursor(page.rows, page.nextCursor);
  }
}
