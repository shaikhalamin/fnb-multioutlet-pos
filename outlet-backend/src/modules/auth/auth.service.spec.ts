import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { AuthService } from './auth.service.js';

const identity: AuthenticatedUser = {
  id: 'user-1',
  email: 'cashier@outlet-a.local',
  roleCodes: ['OUTLET_CASHIER'],
  permissions: ['sales.create'],
  outletId: '11111111-1111-4111-8111-111111111111',
};

type SessionRow = {
  id: string;
  userId: string;
  familyId: string;
  jti: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedAt: Date | null;
};

/** In-memory refresh-session store mirroring the CAS semantics. */
function makeSessionStore(seed: SessionRow[]) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  return {
    findByJti: async (jti: string) =>
      [...rows.values()].find((row) => row.jti === jti) ?? null,
    insert: vi.fn(async (input: { userId: string; familyId: string; jti: string; expiresAt: Date }) => {
      const row: SessionRow = {
        id: `row-${rows.size + 1}`,
        userId: input.userId,
        familyId: input.familyId,
        jti: input.jti,
        expiresAt: input.expiresAt,
        revokedAt: null,
        rotatedAt: null,
      };
      rows.set(row.id, row);
      return row;
    }),
    markRotated: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (!row || row.revokedAt || row.rotatedAt) return false;
      row.rotatedAt = new Date();
      return true;
    }),
    revokeFamily: vi.fn(async (familyId: string) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (row.familyId === familyId && !row.revokedAt) {
          row.revokedAt = new Date();
          affected += 1;
        }
      }
      return affected;
    }),
    rows,
  };
}

function makeJwtMocks() {
  return {
    access: { signAsync: vi.fn(async () => 'access-token') },
    refresh: {
      signAsync: vi.fn(async () => 'refresh-token'),
      verifyAsync: vi.fn(async () => ({ sub: 'user-1', jti: 'jti-1' })),
    },
  };
}

function makeService(
  store: ReturnType<typeof makeSessionStore>,
  overrides: { loadIdentity?: (id: string) => Promise<AuthenticatedUser | null> } = {},
) {
  const config = new ConfigService<Env, true>({
    REFRESH_TOKEN_TTL: 3_600,
    ACCESS_TOKEN_TTL: 900,
  });
  const jwts = makeJwtMocks();
  const service = new AuthService(
    jwts.access as never,
    jwts.refresh as never,
    { findActiveUserWithPermissions: overrides.loadIdentity ?? (async () => identity), findByEmail: async () => null } as never,
    store as never,
    { requireIdentity: async () => ({ outletId: '11111111-1111-4111-8111-111111111111' }) } as never,
    config,
  );
  return { service, jwts, store };
}

describe('AuthService refresh rotation', () => {
  const now = Date.now();
  const activeJti = '11111111-1111-4111-8111-111111111111';
  const activeRow: SessionRow = {
    id: 'row-1',
    userId: 'user-1',
    familyId: 'family-1',
    jti: activeJti,
    expiresAt: new Date(now + 60_000),
    revokedAt: null,
    rotatedAt: null,
  };

  it('rotates: CAS-marks the old row and inserts a successor in the same family', async () => {
    const { service, jwts, store } = makeService(makeSessionStore([{ ...activeRow }]));

    const result = await service.refresh(activeJti);

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(store.markRotated).toHaveBeenCalledWith('row-1');
    const successor = [...store.rows.values()].find((row) => row.id === 'row-2');
    expect(successor?.familyId).toBe('family-1');
    // The signed refresh JWT carries the successor's jti (jwtid option).
    expect(jwts.refresh.signAsync).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ subject: 'user-1', jwtid: successor?.jti }),
    );
  });

  it('signs the outlet claim into every access token (PRD §9.1)', async () => {
    const { service, jwts } = makeService(makeSessionStore([{ ...activeRow }]));

    await service.refresh(activeJti);

    expect(jwts.access.signAsync).toHaveBeenCalledWith(
      { roleCodes: identity.roleCodes, outletId: identity.outletId },
      expect.objectContaining({ subject: 'user-1' }),
    );
  });

  it('re-presenting an already-rotated jti revokes the family and 401s (AT-18)', async () => {
    const { service, store } = makeService(
      makeSessionStore([{ ...activeRow, rotatedAt: new Date(now - 1_000) }]),
    );

    await expect(service.refresh(activeJti)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(store.revokeFamily).toHaveBeenCalledWith('family-1');
  });

  it('loses the CAS race (concurrent refresh) → revoke family and 401', async () => {
    const store = makeSessionStore([{ ...activeRow }]);
    store.markRotated.mockResolvedValue(false);
    const { service } = makeService(store);

    await expect(service.refresh(activeJti)).rejects.toMatchObject({ status: 401 });
    expect(store.revokeFamily).toHaveBeenCalledWith('family-1');
  });

  it('rejects revoked and expired jtis without touching the family', async () => {
    const revokedStore = makeSessionStore([{ ...activeRow, revokedAt: new Date(now - 1) }]);
    await expect(makeService(revokedStore).service.refresh(activeJti)).rejects.toMatchObject({
      status: 401,
    });
    expect(revokedStore.revokeFamily).not.toHaveBeenCalled();

    const expiredStore = makeSessionStore([
      { ...activeRow, expiresAt: new Date(now - 60_000) },
    ]);
    await expect(makeService(expiredStore).service.refresh(activeJti)).rejects.toMatchObject({
      status: 401,
    });
    expect(expiredStore.revokeFamily).not.toHaveBeenCalled();
  });

  it('rejects an unknown jti (unregistered token) with 401', async () => {
    const { service, store } = makeService(makeSessionStore([{ ...activeRow }]));

    await expect(
      service.refresh('22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.revokeFamily).not.toHaveBeenCalled();
  });

  it('revokes the family when the user became inactive since issue', async () => {
    const { service, store } = makeService(makeSessionStore([{ ...activeRow }]), {
      loadIdentity: async () => null,
    });

    await expect(service.refresh(activeJti)).rejects.toMatchObject({ status: 401 });
    expect(store.revokeFamily).toHaveBeenCalledWith('family-1');
  });
});

describe('AuthService login', () => {
  it('rejects unknown or wrong-password accounts with a generic 401', async () => {
    const { service } = makeService(makeSessionStore([]), {
      loadIdentity: async () => identity,
    });

    const missing = await service.login('ghost@outlet-a.local', 'password123').catch((e) => e);
    expect(missing).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});
