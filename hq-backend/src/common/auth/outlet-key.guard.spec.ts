import { Reflector, type ExecutionContext } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ApiKeysRepository } from '../../modules/api-keys/api-keys.repository.js';
import type { AuditService } from '../../modules/audit/audit.service.js';
import { generateOutletKeySecret, hashOutletKeySecret } from '../utils/outlet-key.js';
import { OutletKeyGuard } from './outlet-key.guard.js';
import { RequireKeyScopes } from './require-key-scopes.decorator.js';

const PEPPER = 'unit-test-pepper';
const OUTLET_A = '11111111-1111-4111-8111-111111111111';

class ScopedHandler {
  @RequireKeyScopes('menu.pull')
  handle(): void {
    /* dummy route */
  }
}

class UnscopedHandler {
  handle(): void {
    /* dummy route */
  }
}

function makeContext(
  authorization: string | undefined,
  handler: () => void = ScopedHandler.prototype.handle,
): { context: ExecutionContext; request: { headers: Record<string, string>; outletKey?: unknown } } {
  const request = {
    headers: authorization === undefined ? {} : { authorization },
    outletKey: undefined,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => ScopedHandler,
  } as unknown as ExecutionContext;
  return { context, request };
}

function makeGuard(keyRow: Record<string, unknown> | null) {
  const keys = {
    findByKeyId: vi.fn().mockResolvedValue(keyRow),
    touchLastUsed: vi.fn(),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn().mockReturnValue(PEPPER) };
  const guard = new OutletKeyGuard(
    new Reflector(),
    keys as unknown as ApiKeysRepository,
    audit as unknown as AuditService,
    config as unknown as { get: (key: string, opts?: { infer: boolean }) => string },
  );
  return { guard, keys, audit };
}

function activeKey(overrides: Record<string, unknown> = {}) {
  const secret = generateOutletKeySecret();
  return {
    row: {
      id: '0e2f3a44-0000-4000-8000-000000000001',
      keyId: 'ok_dev_deadbeef',
      outletId: OUTLET_A,
      secretHash: hashOutletKeySecret(secret, PEPPER),
      scopes: ['menu.pull', 'events.push', 'status.write'],
      status: 'ACTIVE',
      expiresAt: null,
      ...overrides,
    },
    secret,
  };
}

describe('OutletKeyGuard', () => {
  it('authenticates a valid key and attaches the server-derived identity', async () => {
    const { row, secret } = activeKey();
    const { guard, keys } = makeGuard(row);
    const { context, request } = makeContext(`OutletKey ${row.keyId}.${secret}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.outletKey).toEqual({ keyId: row.keyId, outletId: OUTLET_A, scopes: row.scopes });
    expect(keys.touchLastUsed).toHaveBeenCalledWith(row.id);
  });

  it('rejects a missing or malformed Authorization header with 401', async () => {
    const { guard, audit } = makeGuard(activeKey().row);
    for (const header of [undefined, 'Bearer token', 'OutletKey nodot', 'OutletKey .leading']) {
      const { context } = makeContext(header);
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
    }
    expect(audit.record).toHaveBeenCalled();
  });

  it('rejects an unknown keyId with 401 and an audit row', async () => {
    const { guard, audit } = makeGuard(null);
    const { context } = makeContext('OutletKey ok_dev_unknown.secret');
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { code: 'UNAUTHENTICATED' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'outlet_key.auth_failed', metadata: expect.objectContaining({ reason: 'unknown_key' }) }),
    );
  });

  it('rejects a wrong secret in constant time with 401', async () => {
    const { row } = activeKey();
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.not-the-secret`);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a revoked key with 401', async () => {
    const { row, secret } = activeKey({ status: 'REVOKED' });
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.${secret}`);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired key (rotated-out predecessor) with 401', async () => {
    const { row, secret } = activeKey({ expiresAt: new Date(Date.now() - 60_000) });
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.${secret}`);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('still authenticates an unexpired rotated predecessor (overlap window)', async () => {
    const { row, secret } = activeKey({ expiresAt: new Date(Date.now() + 3_600_000) });
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.${secret}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('forbids a valid key missing the required scope with 403', async () => {
    const { row, secret } = activeKey({ scopes: ['status.write'] });
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.${secret}`);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 403,
      response: { code: 'FORBIDDEN' },
    });
  });

  it('passes when the route declares no scope requirement', async () => {
    const { row, secret } = activeKey({ scopes: ['status.write'] });
    const { guard } = makeGuard(row);
    const { context } = makeContext(`OutletKey ${row.keyId}.${secret}`, UnscopedHandler.prototype.handle);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
