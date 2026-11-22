import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, In } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { MenuCategoryEntity } from '../../database/entities/menu-category.entity.js';
import { OutletMenuAssignmentEntity } from '../../database/entities/outlet-menu-assignment.entity.js';

export type AssignmentRow = {
  assignmentId: string;
  menuItemId: string;
  sku: string;
  name: string;
  categoryName: string;
  itemStatus: string;
  active: boolean;
  defaultPriceMinor: string;
  priceOverrideMinor: string | null;
  currencyCode: string;
};

/**
 * Assignment persistence (PRD §6.1, FR-02). `(outlet_id, menu_item_id)` is
 * unique — at most one effective assignment row; history is tombstoned via
 * `active = false`, never hard-deleted.
 */
@Injectable()
export class AssignmentsRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * Every assignment of one outlet for the given items, locked `FOR UPDATE` on
   * the caller's transaction: the rows carry `version`, so they are read under
   * lock before `version + 1` is computed (AGENTS §3.4).
   */
  findAssignmentsForUpdate(
    manager: EntityManager,
    outletId: string,
    menuItemIds: string[],
  ): Promise<OutletMenuAssignmentEntity[]> {
    return manager.getRepository(OutletMenuAssignmentEntity).find({
      where: { outletId, menuItemId: In(menuItemIds) },
      order: { menuItemId: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async insertAssignment(
    manager: EntityManager,
    input: {
      outletId: string;
      menuItemId: string;
      priceOverrideMinor: string | null;
      active: boolean;
    },
  ): Promise<OutletMenuAssignmentEntity> {
    const repo = manager.getRepository(OutletMenuAssignmentEntity);
    return repo.save(repo.create({ ...input, version: 1 }));
  }

  async updateAssignment(
    manager: EntityManager,
    assignmentId: string,
    patch: { active?: boolean; priceOverrideMinor?: string | null; version: number },
  ): Promise<void> {
    await manager
      .getRepository(OutletMenuAssignmentEntity)
      .update({ id: assignmentId }, patch)
      .then(() => undefined);
  }

  /** HQ assignment matrix rows: every assignment joined with item + category. */
  async listOutletAssignments(outletId: string): Promise<AssignmentRow[]> {
    const rows = await this.dataSource
      .getRepository(OutletMenuAssignmentEntity)
      .createQueryBuilder('assignment')
      .innerJoin(MasterMenuItemEntity, 'item', 'item.id = assignment.menu_item_id')
      .innerJoin(MenuCategoryEntity, 'category', 'category.id = item.category_id')
      .addSelect('item.sku', 'item_sku')
      .addSelect('item.name', 'item_name')
      .addSelect('item.status', 'item_status')
      .addSelect('item.default_price_minor', 'item_default_price_minor')
      .addSelect('item.currency_code', 'item_currency_code')
      .addSelect('category.name', 'category_name')
      .where('assignment.outlet_id = :outletId', { outletId })
      .orderBy('category.sort_order', 'ASC')
      .addOrderBy('item.name', 'ASC')
      .getRawMany<Record<string, unknown>>();
    return rows.map((row) => ({
      assignmentId: String(row.assignment_id),
      menuItemId: String(row.assignment_menu_item_id),
      sku: String(row.item_sku),
      name: String(row.item_name),
      categoryName: String(row.category_name),
      itemStatus: String(row.item_status),
      active: row.assignment_active === true,
      defaultPriceMinor: String(row.item_default_price_minor),
      priceOverrideMinor:
        row.assignment_price_override_minor === null || row.assignment_price_override_minor === undefined
          ? null
          : String(row.assignment_price_override_minor),
      currencyCode: String(row.item_currency_code),
    }));
  }
}
