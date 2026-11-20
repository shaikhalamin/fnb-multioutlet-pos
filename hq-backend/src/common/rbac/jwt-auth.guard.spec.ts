import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import passport from 'passport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../exceptions/api.exception.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PUBLIC_KEY } from '../auth/public.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { REQUIRE_PERMISSIONS_KEY } from './require-permissions.decorator.js';

const user: AuthenticatedUser = {
  id: 'user-1',
  email: 'admin@fnb.local',
  roleCodes: ['HQ_SUPER_ADMIN'],
  permissions: ['menu.read', 'menu.write'],
};

function makeContext(handler: object): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { headers: { authorization: 'Bearer token' } };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
      getHandler: () => handler,
      getClass: () => class HandlerClass {},
    } as unknown as ExecutionContext,
  };
}

function makeGuard(overrides: { required?: string[]; isPublic?: boolean }) {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === PUBLIC_KEY) return overrides.isPublic ?? false;
      if (key === REQUIRE_PERMISSIONS_KEY) return overrides.required;
      return undefined;
    }),
  };
  return new JwtAuthGuard(reflector as never);
}

/**
 * Registers a stand-in Passport strategy under the guard's real name so
 * `super.canActivate` exercises the genuine Passport dispatch. Success hands
 * the DB-backed identity to the guard (what `JwtStrategy.validate` produces);
 * failure mimics a bad/expired bearer token.
 */
function stubJwtStrategy(outcome: 'success' | 'fail'): void {
  passport.use(
    'jwt',
    {
      authenticate() {
        if (outcome === 'success') this.success(user);
        else this.fail(new Error('invalid token'));
      },
    } as never,
  );
}

afterEach(() => {
  passport.unuse('jwt');
});

describe('JwtAuthGuard', () => {
  it('passes through @Public routes without touching Passport', async () => {
    const guard = makeGuard({ isPublic: true });
    const { context } = makeContext(function handler() {});
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('attaches the Passport identity as request.user and passes when permissions suffice', async () => {
    stubJwtStrategy('success');
    const guard = makeGuard({ required: ['menu.write'] });
    const { context, request } = makeContext(function handler() {});
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(user);
  });

  it('propagates Passport authentication failures as UnauthorizedException (401 path)', async () => {
    stubJwtStrategy('fail');
    const guard = makeGuard({});
    const { context } = makeContext(function handler() {});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects with 403 FORBIDDEN when a required permission is missing', async () => {
    stubJwtStrategy('success');
    const guard = makeGuard({ required: ['keys.manage'] });
    const { context } = makeContext(function handler() {});
    const rejection = await guard.canActivate(context).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ApiException);
    expect(rejection).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
