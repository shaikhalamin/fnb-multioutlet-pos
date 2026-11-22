import { Global, Module } from '@nestjs/common';
import { HqCredentialsProvider } from './hq-credentials.provider.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';

/**
 * Global: outlet identity + HQ connection singletons are consumed across
 * feature modules (auth JWT pinning, sales scoping, menu-pull verification,
 * sync status, setup provisioning) without per-module imports.
 */
@Global()
@Module({
  providers: [IdentityRepository, IdentityService, HqCredentialsProvider],
  exports: [IdentityRepository, IdentityService, HqCredentialsProvider],
})
export class IdentityModule {}
