import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { OutletCatalogChangeEntity } from '../../database/entities/outlet-catalog-change.entity.js';
import type { CatalogChangeAction } from '../../database/entities/outlet-catalog-change.entity.js';
import { OutletCatalogRevisionEntity } from '../../database/entities/outlet-catalog-revision.entity.js';

export type CatalogChange = {
  outletId: string;
  action: CatalogChangeAction;
  payload: Record<string, unknown>;
};

/**
 * Appends per-outlet catalog change-log entries inside the caller's
 * transaction (PRD §8.2): for each affected outlet, in deterministic
 * outlet-ID order, bump its locked revision row (`UPDATE … RETURNING` takes
 * the row lock) and insert the change at that revision. A menu mutation can
 * never commit without its durable distribution record (§8.2 rule 5).
 */
@Injectable()
export class CatalogChangesService {
  async appendChanges(
    manager: EntityManager,
    changes: CatalogChange[],
  ): Promise<OutletCatalogChangeEntity[]> {
    const queue = [...changes].sort((a, b) => (a.outletId < b.outletId ? -1 : 1));
    const appended: OutletCatalogChangeEntity[] = [];
    for (const change of queue) {
      const bumped = await manager
        .createQueryBuilder()
        .update(OutletCatalogRevisionEntity)
        .set({ currentRevision: () => 'current_revision + 1' })
        .where('outlet_id = :outletId', { outletId: change.outletId })
        .returning('current_revision')
        .execute();
      const revision = (bumped.raw as Array<{ current_revision: string | bigint }>)[0]
        ?.current_revision;
      if (revision === undefined) {
        throw new Error(`catalog revision row missing for outlet ${change.outletId}`);
      }
      const repo = manager.getRepository(OutletCatalogChangeEntity);
      const inserted = await repo.save(
        repo.create({
          outletId: change.outletId,
          revision: revision.toString(),
          action: change.action,
          payload: change.payload,
        }),
      );
      appended.push(inserted);
    }
    return appended;
  }
}
