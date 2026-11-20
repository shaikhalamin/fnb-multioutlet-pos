import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './authenticated-user.js';

/**
 * Injects the authenticated HQ user resolved by `JwtAuthGuard` into a
 * controller argument. Identity always comes from the verified token and the
 * server-side user record — never from request JSON (PRD §3, §15).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);
