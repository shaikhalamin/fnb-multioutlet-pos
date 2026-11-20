import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global: security-relevant services across modules record audit rows. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
