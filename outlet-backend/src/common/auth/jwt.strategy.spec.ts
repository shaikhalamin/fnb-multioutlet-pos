import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from './authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { JwtStrategy } from './jwt.strategy.js';

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';

const identity: AuthenticatedUser = {
  id: 'user-1',
  email: 'cashier@outlet-a.local',
  roleCodes: ['OUTLET_CASHIER'],
  permissions: ['sales.create'],
  outletId: OUTLET_ID,
};

function makeStrategy(
  loadIdentity: (id: string) => Promise<AuthenticatedUser | null> = async () => identity,
  outletIdentity: { outletId: string } | null = { outletId: OUTLET_ID },
): JwtStrategy {
  const config = new ConfigService<Env, true>({
    OUTLET_JWT_ISSUER: 'fnb-outlet',
    OUTLET_JWT_AUDIENCE: 'fnb-outlet-api',
    OUTLET_JWT_ACCESS_SECRET: 'unit-test-access-secret-0123456789abcdef',
  });
  return new JwtStrategy(
    config,
    {
      findActiveUserWithPermissions: loadIdentity,
    } as never,
    { findIdentity: async () => outletIdentity } as never,
  );
}

describe('JwtStrategy outlet identity assertion (PRD §3)', () => {
  it('accepts a token whose outletId claim matches this deployment', async () => {
    const strategy = makeStrategy();
    const user = await strategy.validate({ sub: 'user-1', jti: 'jti-1', outletId: OUTLET_ID });
    expect(user.id).toBe('user-1');
  });

  it('rejects a validly-signed token minted for a different outlet', async () => {
    const strategy = makeStrategy();
    await expect(
      strategy.validate({
        sub: 'user-1',
        jti: 'jti-1',
        outletId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token without an outletId claim', async () => {
    const strategy = makeStrategy();
    await expect(strategy.validate({ sub: 'user-1', jti: 'jti-1' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects everything on an unprovisioned terminal (no identity row)', async () => {
    const strategy = makeStrategy(async () => identity, null);
    await expect(
      strategy.validate({ sub: 'user-1', jti: 'jti-1', outletId: OUTLET_ID }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the user no longer exists or is inactive', async () => {
    const strategy = makeStrategy(async () => null);
    await expect(
      strategy.validate({ sub: 'ghost', jti: 'jti-1', outletId: OUTLET_ID }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
