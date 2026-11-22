import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { HqCredentialChecker } from '../sync/clients/hq-credential-checker.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

/**
 * First-run provisioning surface: the public-until-sealed setup wizard
 * endpoints plus the shared provisioning helpers. `SetupService` is exported
 * because the authenticated sync surface reuses its validate-then-save
 * connection logic for key rotation.
 */
@Module({
  imports: [AuditModule],
  controllers: [SetupController],
  providers: [SetupService, HqCredentialChecker],
  exports: [SetupService],
})
export class SetupModule {}
