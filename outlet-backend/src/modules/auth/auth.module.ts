import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from '../../common/auth/jwt.strategy.js';
import { JwtRefreshStrategy } from '../../common/auth/jwt-refresh.strategy.js';
import { AuthController } from './auth.controller.js';
import { AuthUserRepository } from './auth-user.repository.js';
import { AuthService } from './auth.service.js';
import {
  ACCESS_JWT_SERVICE,
  REFRESH_JWT_SERVICE,
  accessJwtProvider,
  refreshJwtProvider,
} from './auth.providers.js';
import { RefreshSessionRepository } from './refresh-session.repository.js';

/**
 * Global: the Passport strategies registered here back the global JWT guard
 * (`common/rbac`) and the refresh-cookie guard, and every feature module
 * consumes the identity repository exported here.
 */
@Global()
@Module({
  imports: [PassportModule],
  controllers: [AuthController],
  providers: [
    JwtStrategy,
    JwtRefreshStrategy,
    accessJwtProvider,
    refreshJwtProvider,
    AuthUserRepository,
    RefreshSessionRepository,
    AuthService,
  ],
  exports: [ACCESS_JWT_SERVICE, REFRESH_JWT_SERVICE, AuthUserRepository, RefreshSessionRepository, AuthService],
})
export class AuthModule {}
