import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { AuditLogEntity } from '../../database/entities/audit-log.entity.js';
import { AuditController } from './audit.controller.js';
import { REQUIRE_PERMISSIONS_KEY } from '../../common/rbac/require-permissions.decorator.js';
import type { AuditLogsRepository } from './audit.repository.js';
import { AuditReadService } from './audit-read.service.js';
import type { ListAuditLogsQuery } from './dto/audit.dto.js';

const ACTOR_ID = '3f7a4d60-1a08-4f0e-9e94-6c1e4f0e2a11';

function auditRow(patch: Partial<AuditLogEntity> = {}): AuditLogEntity {
  return {
    id: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11',
    actorType: 'USER',
    actorId: ACTOR_ID,
    action: 'auth.login_failed',
    entityType: 'api_key',
    entityId: '9f2b1c20-7d5e-4a3f-b1c0-8e2d6f7a9b31',
    metadata: { reason: 'bad_credentials' },
    occurredAt: new Date('2026-11-20T04:02:10.000Z'),
    ...patch,
  } as AuditLogEntity;
}

function makeService(page: { rows: AuditLogEntity[]; nextCursor?: string }) {
  const logs = {
    list: vi.fn().mockResolvedValue({ rows: page.rows, nextCursor: page.nextCursor }),
  };
  const service = new AuditReadService(logs as unknown as AuditLogsRepository);
  return { service, logs };
}

const query = (patch: Partial<ListAuditLogsQuery> = {}): ListAuditLogsQuery => ({
  ...patch,
});

describe('AuditController', () => {
  it('guards the audit surface with the super-admin-only audit.read permission (§9.3)', () => {
    const reflector = new Reflector();
    const required = reflector.get<string[]>(REQUIRE_PERMISSIONS_KEY, AuditController.prototype["listLogs"]);
    expect(required).toEqual(['audit.read']);
  });
});

describe('AuditReadService.list', () => {
  it('maps rows to the response DTO with ISO occurredAt', async () => {
    const { service } = makeService({ rows: [auditRow()] });
    const page = await service.list(query());
    expect(page.rows).toEqual([
      {
        id: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11',
        actorType: 'USER',
        actorId: ACTOR_ID,
        action: 'auth.login_failed',
        entityType: 'api_key',
        entityId: '9f2b1c20-7d5e-4a3f-b1c0-8e2d6f7a9b31',
        metadata: { reason: 'bad_credentials' },
        occurredAt: '2026-11-20T04:02:10.000Z',
      },
    ]);
  });

  it('defaults the page size to 50 (limit clamp handled by the DTO @Max(100))', async () => {
    const { service, logs } = makeService({ rows: [] });
    await service.list(query());
    expect(logs.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    await service.list(query({ limit: 100 }));
    expect(logs.list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('passes every filter combination through to the repository', async () => {
    const { service, logs } = makeService({ rows: [] });
    await service.list(
      query({
        action: 'auth.login_failed',
        actorId: ACTOR_ID,
        entityId: '9f2b1c20-7d5e-4a3f-b1c0-8e2d6f7a9b31',
        from: '2026-11-01T00:00:00Z',
        to: '2026-12-01T00:00:00Z',
      }),
    );
    expect(logs.list).toHaveBeenCalledWith({
      limit: 50,
      action: 'auth.login_failed',
      actorId: ACTOR_ID,
      entityId: '9f2b1c20-7d5e-4a3f-b1c0-8e2d6f7a9b31',
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      cursor: undefined,
    });
  });

  it('decodes a valid cursor and tolerates malformed ones (menu-listing precedent)', async () => {
    const { service, logs } = makeService({ rows: [] });
    const cursor = Buffer.from(
      JSON.stringify({ occurredAt: '2026-11-20T04:02:10.000Z', id: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11' }),
      'utf8',
    ).toString('base64url');
    await service.list(query({ cursor }));
    // The exact (occurredAt, id) pair is what keeps pagination stable under
    // concurrent writes — newer rows sort above the keyset and never shift it.
    expect(logs.list).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { occurredAt: '2026-11-20T04:02:10.000Z', id: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11' },
      }),
    );

    await service.list(query({ cursor: '!!!not-base64-json!!!' }));
    expect(logs.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: undefined }));
  });

  it('forwards the next cursor so the envelope can hoist meta.nextCursor', async () => {
    const { service } = makeService({ rows: [auditRow()], nextCursor: 'next-token' });
    const page = await service.list(query());
    expect(page.nextCursor).toBe('next-token');
  });
});
