import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { HqConnectionEntity } from '../../database/entities/hq-connection.entity.js';
import { OutletIdentityEntity } from '../../database/entities/outlet-identity.entity.js';

/** Values needed to insert or replace the `hq_connection` singleton. */
export type HqConnectionValues = {
  outletId: string;
  hqBaseUrl: string;
  keyId: string;
  keySecret: string;
  lastValidatedAt: Date;
};

/**
 * Singleton-row repository for `outlet_identity` and `hq_connection` (PRD
 * §6.2, §8.7). Every write method takes the caller's transaction `manager`
 * first — provisioning commits identity, counters, roles and the admin user
 * (or the connection row and its audit record) as ONE atomic unit.
 */
@Injectable()
export class IdentityRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  // ---- outlet_identity -----------------------------------------------------

  async findIdentity(manager?: EntityManager): Promise<OutletIdentityEntity | null> {
    const repository = manager
      ? manager.getRepository(OutletIdentityEntity)
      : this.dataSource.getRepository(OutletIdentityEntity);
    return repository.findOne({ where: {} });
  }

  async insertIdentity(
    manager: EntityManager,
    values: { outletId: string; outletCode: string },
  ): Promise<void> {
    // Informational columns stay null: wizard provisioning knows only the
    // HQ-issued ID and code; currency is backfilled from the first menu pull.
    await manager.getRepository(OutletIdentityEntity).insert(
      manager.getRepository(OutletIdentityEntity).create({
        outletId: values.outletId,
        outletCode: values.outletCode,
        companyId: null,
        timezone: null,
        currencyCode: null,
      }),
    );
  }

  // ---- hq_connection -------------------------------------------------------

  async findConnection(manager?: EntityManager): Promise<HqConnectionEntity | null> {
    const repository = manager
      ? manager.getRepository(HqConnectionEntity)
      : this.dataSource.getRepository(HqConnectionEntity);
    return repository.findOne({ where: {} });
  }

  async insertConnection(manager: EntityManager, values: HqConnectionValues): Promise<void> {
    await manager.getRepository(HqConnectionEntity).insert(
      manager.getRepository(HqConnectionEntity).create(values),
    );
  }

  /** Replaces the stored key/base URL (rotation); keeps a single row. */
  async replaceConnection(manager: EntityManager, values: HqConnectionValues): Promise<void> {
    await manager.getRepository(HqConnectionEntity).save(
      manager.getRepository(HqConnectionEntity).create(values),
    );
  }
}
