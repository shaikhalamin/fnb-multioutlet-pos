import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiException } from '../exceptions/api.exception.js';

/**
 * Route guard for `POST /auth/refresh`: authenticates the HttpOnly refresh
 * cookie through the `jwt-refresh` Passport strategy. Any unusable cookie —
 * missing, bad signature, wrong issuer/audience, expired — is a single
 * generic 401; rotation-state checks stay in `AuthService`.
 */
@Injectable()
export class JwtRefreshAuthGuard extends AuthGuard('jwt-refresh') {
  handleRequest<TUser = unknown>(error: unknown, user: unknown): TUser {
    if (error !== null && error !== undefined) {
      throw new ApiException('UNAUTHENTICATED', 'Refresh token missing or invalid.', 401);
    }
    if (!user) {
      throw new ApiException('UNAUTHENTICATED', 'Refresh token missing or invalid.', 401);
    }
    return user as TUser;
  }
}
