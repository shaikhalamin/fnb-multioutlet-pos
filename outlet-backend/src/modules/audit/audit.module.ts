import { Global, Module } from '@nestjs/common';
import { OutletAuditService } from './outlet-audit.service.js';

/** Global: sync workers, the sale path's override check and status reads share the audit trail. */
@Global()
@Module({
  providers: [OutletAuditService],
  exports: [OutletAuditService],
})
export class AuditModule {}
