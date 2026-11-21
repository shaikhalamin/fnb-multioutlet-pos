import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditLogsRepository } from './audit.repository.js';
import { AuditReadService } from './audit-read.service.js';
import { AuditRetentionService } from './audit-retention.service.js';
import { AuditService } from './audit.service.js';

/** Global: security-relevant services across modules record audit rows. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditLogsRepository, AuditReadService, AuditRetentionService],
  exports: [AuditService],
})
export class AuditModule {}
