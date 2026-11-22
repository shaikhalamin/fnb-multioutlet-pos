import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import type { OutletAuditService } from '../audit/outlet-audit.service.js';
import type { HqCredentialChecker } from '../sync/clients/hq-credential-checker.js';
import type { IdentityRepository } from '../identity/identity.repository.js';
import type { IdentityService } from '../identity/identity.service.js';
import { SetupService } from './setup.service.js';
import type {
  CreateOutletIdentityRequest,
  SaveHqConnectionRequest,
} from './dto/setup.dto.js';

const OUTLET_ID = '11111111-1111-4111-8111-111111111111';

/**
 * In-memory fake of the singleton rows + provisioning writes: every insert
 * goes through the same in-memory "manager", so sealing semantics and the
 * validate-then-save order are observable without PostgreSQL (the e2e suite
 * covers the real transaction).
 */
type IdentityRow = { outletId: string; outletCode: string };

function makeFakes() {
  const identityRow: IdentityRow | null = null;
  let connectionRow: Record<string, unknown> | null = null;
  const inserted: string[] = [];

  const identities = {
    findIdentity: vi.fn(async (): Promise<IdentityRow | null> => identityRow),
    findConnection: vi.fn(async (): Promise<Record<string, unknown> | null> => connectionRow),
    insertIdentity: vi.fn(async (_manager: EntityManager, values: { outletId: string; outletCode: string }) => {
      inserted.push(`identity:${values.outletId}`);
    }),
    insertConnection: vi.fn(async (_manager: EntityManager, values: Record<string, unknown>) => {
      inserted.push(`connection:${values.keyId as string}`);
      connectionRow = { ...values };
    }),
    replaceConnection: vi.fn(async (_manager: EntityManager, values: Record<string, unknown>) => {
      inserted.push(`replace:${values.keyId as string}`);
      connectionRow = { ...values };
    }),
  };
  const identity = {
    // Delegates to the mocked repository so per-test overrides apply.
    findIdentity: async () => identities.findIdentity(),
    requireIdentity: async () => {
      const row = await identities.findIdentity();
      if (!row) throw new Error('not provisioned');
      return row;
    },
  };
  const audit = {
    record: vi.fn(async (_event: Record<string, unknown>, _manager?: unknown) => undefined),
  };
  return { identities, identity, audit, inserted, get connectionRow() { return connectionRow; } };
}

function makeChecker(result: unknown) {
  return { check: vi.fn(async () => result) };
}

function makeService(fakes: ReturnType<typeof makeFakes>, checkerResult: unknown) {
  const dataSource = {
    transaction: vi.fn(async (fn: (manager: EntityManager) => Promise<unknown>) => fn({} as EntityManager)),
  };
  return {
    service: new SetupService(
      dataSource as unknown as DataSource,
      fakes.identities as unknown as IdentityRepository,
      fakes.identity as unknown as IdentityService,
      makeChecker(checkerResult) as unknown as HqCredentialChecker,
      fakes.audit as unknown as OutletAuditService,
    ),
    dataSource,
  };
}

const IDENTITY_REQUEST: CreateOutletIdentityRequest = {
  outletId: OUTLET_ID,
  outletCode: 'A',
  adminEmail: 'Admin@Outlet-A.local',
  adminPassword: 'Admin123!',
};

const CONNECTION_REQUEST: SaveHqConnectionRequest = {
  hqApiBaseUrl: 'http://hq-api:3000/api/v1',
  keyId: 'ok_dev_0123456789abcdef',
  keySecret: 'one-time-secret-from-hq-console',
};

const ACCEPTED_CHECK = { ok: true, outletId: OUTLET_ID, highestContiguousSequence: '0' };

describe('SetupService sealing (public only while unprovisioned)', () => {
  it('rejects pairing before identity exists (step order enforced)', async () => {
    const fakes = makeFakes();
    const { service } = makeService(fakes, ACCEPTED_CHECK);
    await expect(service.saveHqConnection(CONNECTION_REQUEST)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(fakes.inserted).toEqual([]);
  });

  it('seals identity permanently once provisioned', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    const { service } = makeService(fakes, ACCEPTED_CHECK);

    await expect(service.createIdentity(IDENTITY_REQUEST)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});

describe('SetupService validate-then-save (§9.2 provisioning channel)', () => {
  it('saves nothing when HQ rejects the key', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    const { service } = makeService(fakes, { ok: false, kind: 'REJECTED' });

    await expect(service.saveHqConnection(CONNECTION_REQUEST)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(fakes.inserted).toEqual([]);
  });

  it('saves nothing when HQ is unreachable at that URL', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    const { service } = makeService(fakes, { ok: false, kind: 'UNREACHABLE' });

    await expect(service.saveHqConnection(CONNECTION_REQUEST)).rejects.toMatchObject({
      code: 'SYNC_TEMPORARILY_UNAVAILABLE',
      status: 503,
    });
    expect(fakes.inserted).toEqual([]);
  });

  it('refuses a key that belongs to a different outlet (HQ derives outletId from the key)', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    const { service } = makeService(fakes, {
      ok: true,
      outletId: '99999999-9999-4999-8999-999999999999',
      highestContiguousSequence: '0',
    });

    await expect(service.saveHqConnection(CONNECTION_REQUEST)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
      details: expect.objectContaining({ keyOutletId: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(fakes.inserted).toEqual([]);
  });

  it('persists the connection only after live validation succeeds', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    fakes.identities.findConnection.mockResolvedValue(null);
    const { service } = makeService(fakes, ACCEPTED_CHECK);

    const response = await service.saveHqConnection(CONNECTION_REQUEST);
    expect(response).toMatchObject({ outletId: OUTLET_ID, keyId: CONNECTION_REQUEST.keyId });
    expect(fakes.inserted).toEqual([`connection:${CONNECTION_REQUEST.keyId}`]);
    // The audit row carries the keyId, never the secret.
    const auditEvent = fakes.audit.record.mock.calls[0]?.[0];
    expect(JSON.stringify(auditEvent)).not.toContain(CONNECTION_REQUEST.keySecret);
    expect(JSON.stringify(auditEvent)).toContain(CONNECTION_REQUEST.keyId);
  });

  it('seals pairing permanently once a connection exists (rotation must use the authenticated route)', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    fakes.identities.findConnection.mockResolvedValue({ keyId: 'existing' });
    const { service } = makeService(fakes, ACCEPTED_CHECK);

    await expect(service.saveHqConnection(CONNECTION_REQUEST)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(fakes.inserted).toEqual([]);
  });

  it('rotation via the authenticated route replaces the stored key after validation', async () => {
    const fakes = makeFakes();
    fakes.identities.findIdentity.mockResolvedValue({ outletId: OUTLET_ID, outletCode: 'A' });
    fakes.identities.findConnection.mockResolvedValue({ keyId: 'old-key' });
    const { service } = makeService(fakes, ACCEPTED_CHECK);

    const response = await service.updateHqConnection(CONNECTION_REQUEST, {
      id: 'manager-1',
      email: 'manager@outlet-a.local',
    });
    expect(response.keyId).toBe(CONNECTION_REQUEST.keyId);
    expect(fakes.inserted).toEqual([`replace:${CONNECTION_REQUEST.keyId}`]);
  });
});
