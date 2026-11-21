import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { MenuCategoryEntity } from '../../database/entities/menu-category.entity.js';
import { OutletCatalogChangeEntity } from '../../database/entities/outlet-catalog-change.entity.js';
import { OutletCatalogRevisionEntity } from '../../database/entities/outlet-catalog-revision.entity.js';
import { OutletMenuAssignmentEntity } from '../../database/entities/outlet-menu-assignment.entity.js';

export type CatalogChangeRow = {
  revision: string;
  action: 'UPSERT' | 'REMOVE';
  payload: Record<string, unknown>;
  menuItemId: string | null;
};

export type SnapshotItemRow = {
  menuItemId: string;
  assignmentId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  unitPriceMinor: string;
  currencyCode: string;
  active: boolean;
  itemVersion: number;
};

/**
 * Read side of the per-outlet catalog change log and snapshot view
 * (PRD §8.3). All queries are scoped to the authenticated key's outlet;
 * assignment joins only resolve item identity for change entries written
 * before payloads became self-contained — effective state always comes from
 * the stored payload itself (§8.2 rule 4).
 */
@Injectable()
export class MenuPullRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  headRevision(outletId: string, manager?: EntityManager): Promise<string> {
    const repo = (manager ?? this.dataSource).getRepository(OutletCatalogRevisionEntity);
    return repo
      .findOne({ where: { outletId } })
      .then((row) => row?.currentRevision ?? '0');
  }

  /** Lowest retained revision for the outlet — detects history truncation. */
  async minAvailableRevision(outletId: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ min: string | null }[]>(
      'SELECT MIN(revision)::text AS min FROM outlet_catalog_changes WHERE outlet_id = $1',
      [outletId],
    );
    return rows[0]?.min ?? null;
  }

  listChangesAfter(
    outletId: string,
    afterRevision: string,
    limit: number,
  ): Promise<CatalogChangeRow[]> {
    return this.dataSource
      .createQueryBuilder()
      .select('c.revision::text', 'revision')
      .addSelect('c.action', 'action')
      .addSelect('c.payload', 'payload')
      // Legacy UPSERT payloads predate self-contained menuItemId; resolve the
      // immutable assignment row instead (never the live item state).
      .addSelect("COALESCE(c.payload->>'menuItemId', a.menu_item_id::text)", 'menuItemId')
      .from(OutletCatalogChangeEntity, 'c')
      .leftJoin(OutletMenuAssignmentEntity, 'a', "a.id::text = c.payload->>'assignmentId'")
      .where('c.outlet_id = :outletId AND c.revision > :after', { outletId, after: afterRevision })
      .orderBy('c.revision', 'ASC')
      .take(limit)
      .getRawMany<CatalogChangeRow>();
  }

  /**
   * Full effective catalog for one outlet — active AND inactive assignments
   * (inactive entries carry `active:false` so the outlet can tombstone) —
   * evaluated inside the caller's REPEATABLE READ transaction so the snapshot
   * revision and rows are one stable view (§8.3 snapshot correctness).
   */
  listSnapshotItems(manager: EntityManager, outletId: string): Promise<SnapshotItemRow[]> {
    return manager
      .createQueryBuilder()
      .select('a.menu_item_id::text', 'menuItemId')
      .addSelect('a.id::text', 'assignmentId')
      .addSelect('i.sku', 'sku')
      .addSelect('i.name', 'name')
      .addSelect('i.description', 'description')
      .addSelect('c.name', 'category')
      .addSelect('COALESCE(a.price_override_minor, i.default_price_minor)::text', 'unitPriceMinor')
      .addSelect('i.currency_code', 'currencyCode')
      .addSelect('(a.active AND i.status = \'ACTIVE\')', 'active')
      .addSelect('i.version', 'itemVersion')
      .from(OutletMenuAssignmentEntity, 'a')
      .innerJoin(MasterMenuItemEntity, 'i', 'i.id = a.menu_item_id')
      .innerJoin(MenuCategoryEntity, 'c', 'c.id = i.category_id')
      .where('a.outlet_id = :outletId', { outletId })
      .orderBy('a.menu_item_id', 'ASC')
      .getRawMany<SnapshotItemRow>();
  }
}
