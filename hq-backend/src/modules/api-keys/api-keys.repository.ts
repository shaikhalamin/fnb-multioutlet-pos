import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletApiKeyEntity } from '../../database/entities/outlet-api-key.entity.js';

/**
 * Outlet machine-key persistence (PRD §6.1, §9.2). Only the peppered HMAC of
 * the secret is stored; `key_id` is the public lookup handle. Multiple
 * overlapping ACTIVE keys are allowed for rotation.
 */
@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  insert(
    manager: EntityManager,
    input: {
      keyId: string;
      outletId: string;
      secretHash: string;
      scopes: string[];
      expiresAt: Date | null;
      rotatedFromId: string | null;
    },
  ): Promise<OutletApiKeyEntity> {
    const repo = manager.getRepository(OutletApiKeyEntity);
    return repo.save(repo.create({ ...input, status: 'ACTIVE', lastUsedAt: null }));
  }

  findByKeyId(keyId: string): Promise<OutletApiKeyEntity | null> {
    return this.dataSource.getRepository(OutletApiKeyEntity).findOne({ where: { keyId } });
  }

  listByOutlet(outletId: string): Promise<OutletApiKeyEntity[]> {
    return this.dataSource
      .getRepository(OutletApiKeyEntity)
      .find({ where: { outletId }, order: { createdAt: 'DESC' } });
  }

  setExpiry(manager: EntityManager, id: string, expiresAt: Date): Promise<void> {
    return manager
      .getRepository(OutletApiKeyEntity)
      .update({ id }, { expiresAt })
      .then(() => undefined);
  }

  revoke(manager: EntityManager, id: string): Promise<void> {
    return manager
      .getRepository(OutletApiKeyEntity)
      .update({ id }, { status: 'REVOKED' })
      .then(() => undefined);
  }

  /**
   * Fire-and-forget `last_used_at` refresh for the Phase 3 sync guard — a
   * liveness signal for rotation confirmation (PRD §9.2), never part of a
   * larger transaction. Failures are swallowed on purpose.
   */
  touchLastUsed(id: string): void {
    this.dataSource
      .getRepository(OutletApiKeyEntity)
      .update({ id }, { lastUsedAt: new Date() })
      .catch(() => undefined);
  }
}
