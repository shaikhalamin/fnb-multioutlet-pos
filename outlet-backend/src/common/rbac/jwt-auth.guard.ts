import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../exceptions/api.exception.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PUBLIC_KEY } from '../auth/public.decorator.js';
import { REQUIRE_PERMISSIONS_KEY } from './require-permissions.decorator.js';

/**
 * Global authentication + RBAC gate (PRD FR-09, §9.3). Delegates bearer-JWT
 * verification to Passport's `jwt` strategy — which also reloads the user
 * (status + permissions) from the outlet database so revocations and role
 * changes apply immediately, and asserts the token's `outletId` claim
 * matches this deployment — then enforces `@RequirePermissions` on the
 * authenticated identity. Never trusts identity from request JSON.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Passport verifies the token and attaches the DB-backed identity to
    // `request.user`; failures surface as 401 UNAUTHENTICATED via the global
    // exception filter.
    await super.canActivate(context);

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0) {
      const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
      const held = new Set(request.user?.permissions ?? []);
      const missing = required.filter((permission) => !held.has(permission));
      if (missing.length > 0) {
        throw new ApiException('FORBIDDEN', 'You do not have permission to perform this action.', 403, {
          requiredPermissions: required,
        });
      }
    }
    return true;
  }
}
