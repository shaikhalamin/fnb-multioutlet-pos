import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { OutletCatalogRevisionEntity } from '../../database/entities/outlet-catalog-revision.entity.js';
import { OutletEntity } from '../../database/entities/outlet.entity.js';

export type OutletWithRevision = OutletEntity & { catalogRevision: string };

/**
 * Outlet persistence (PRD §6.1). Provisioning inserts the outlet and its
 * locked revision row (revision 0) in one transaction so an outlet can never
 * exist without its per-outlet catalog revision.
 */
@Injectable()
export class OutletsRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async list(companyId: string): Promise<OutletWithRevision[]> {
    const outlets = await this.dataSource
      .getRepository(OutletEntity)
      .find({ where: { companyId }, order: { code: 'ASC' } });
    return Promise.all(outlets.map((outlet) => this.withRevision(outlet)));
  }

  async findById(companyId: string, outletId: string): Promise<OutletWithRevision | null> {
    const outlet = await this.dataSource
      .getRepository(OutletEntity)
      .findOne({ where: { id: outletId, companyId } });
    return outlet ? this.withRevision(outlet) : null;
  }

  async findByCode(companyId: string, code: string): Promise<OutletEntity | null> {
    return this.dataSource.getRepository(OutletEntity).findOne({ where: { companyId, code } });
  }

  async insertOutlet(
    input: { companyId: string; code: string; name: string; timezone: string },
    revision = '0',
  ): Promise<OutletWithRevision> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(OutletEntity);
      const outlet = await repo.save(
        repo.create({ ...input, status: 'ACTIVE' }),
      );
      const revisionRepo = manager.getRepository(OutletCatalogRevisionEntity);
      await revisionRepo.save(revisionRepo.create({ outletId: outlet.id, currentRevision: revision }));
      return { ...outlet, catalogRevision: revision };
    });
  }

  async update(
    outletId: string,
    patch: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' },
  ): Promise<void> {
    await this.dataSource.getRepository(OutletEntity).update({ id: outletId }, patch);
  }

  private async withRevision(outlet: OutletEntity): Promise<OutletWithRevision> {
    const row = await this.dataSource
      .getRepository(OutletCatalogRevisionEntity)
      .findOne({ where: { outletId: outlet.id } });
    return { ...outlet, catalogRevision: row?.currentRevision ?? '0' };
  }
}
