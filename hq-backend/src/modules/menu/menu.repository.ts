import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { MenuCategoryEntity } from '../../database/entities/menu-category.entity.js';
import { OutletMenuAssignmentEntity } from '../../database/entities/outlet-menu-assignment.entity.js';

export type MenuItemWithCategory = MasterMenuItemEntity & { categoryName: string };

export type AssignmentTarget = {
  outletId: string;
  assignmentId: string;
  priceOverrideMinor: string | null;
};

/**
 * Master catalog persistence (PRD §6.1, FR-01). Also discovers fan-out
 * targets: read-only joins over `outlet_menu_assignments` so menu mutations
 * can append per-outlet changes without owning assignment writes.
 */
@Injectable()
export class MenuRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  // ---- Categories -----------------------------------------------------------

  listCategories(companyId: string): Promise<MenuCategoryEntity[]> {
    return this.dataSource
      .getRepository(MenuCategoryEntity)
      .find({ where: { companyId }, order: { sortOrder: 'ASC', name: 'ASC' } });
  }

  findCategory(companyId: string, categoryId: string): Promise<MenuCategoryEntity | null> {
    return this.dataSource
      .getRepository(MenuCategoryEntity)
      .findOne({ where: { id: categoryId, companyId } });
  }

  findCategoryByName(companyId: string, name: string): Promise<MenuCategoryEntity | null> {
    return this.dataSource
      .getRepository(MenuCategoryEntity)
      .findOne({ where: { companyId, name } });
  }

  insertCategory(
    manager: EntityManager,
    input: { companyId: string; name: string; sortOrder: number },
  ): Promise<MenuCategoryEntity> {
    const repo = manager.getRepository(MenuCategoryEntity);
    return repo.save(repo.create({ ...input, status: 'ACTIVE' }));
  }

  updateCategory(
    manager: EntityManager,
    categoryId: string,
    patch: { name?: string; sortOrder?: number; status?: 'ACTIVE' | 'ARCHIVED' },
  ): Promise<void> {
    return manager.getRepository(MenuCategoryEntity).update({ id: categoryId }, patch).then(() => undefined);
  }

  countActiveItemsInCategory(categoryId: string): Promise<number> {
    return this.dataSource
      .getRepository(MasterMenuItemEntity)
      .count({ where: { categoryId, status: 'ACTIVE' } });
  }

  // ---- Master items ---------------------------------------------------------

  listItems(filter: {
    companyId: string;
    categoryId?: string;
    status?: string;
    search?: string;
    limit: number;
    cursor?: { createdAt: string; id: string };
  }): Promise<{ items: MenuItemWithCategory[]; nextCursor: string | undefined }> {
    const query = this.dataSource
      .getRepository(MasterMenuItemEntity)
      .createQueryBuilder('item')
      .innerJoin(MenuCategoryEntity, 'category', 'category.id = item.category_id')
      .addSelect('category.name', 'category_name')
      .where('item.company_id = :companyId', { companyId: filter.companyId })
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .take(filter.limit + 1);
    if (filter.categoryId) query.andWhere('item.category_id = :categoryId', { categoryId: filter.categoryId });
    if (filter.status) query.andWhere('item.status = :status', { status: filter.status });
    if (filter.search) {
      query.andWhere('(item.name ILIKE :search OR item.sku ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }
    if (filter.cursor) {
      query.andWhere('(item.created_at, item.id) < (:createdAt, :id)', {
        createdAt: new Date(filter.cursor.createdAt),
        id: filter.cursor.id,
      });
    }
    return query.getRawAndEntities().then(({ entities, raw }) => {
      const names = new Map(
        raw.map((row) => [
          String((row as Record<string, unknown>).item_id),
          String((row as Record<string, unknown>).category_name),
        ]),
      );
      const hasMore = entities.length > filter.limit;
      const page = hasMore ? entities.slice(0, filter.limit) : entities;
      const last = page.at(-1);
      return {
        items: page.map((item) => ({ ...item, categoryName: names.get(item.id) ?? '' })),
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
                'utf8',
              ).toString('base64url')
            : undefined,
      };
    });
  }

  findItem(companyId: string, itemId: string): Promise<MenuItemWithCategory | null> {
    return this.dataSource
      .getRepository(MasterMenuItemEntity)
      .createQueryBuilder('item')
      .innerJoin(MenuCategoryEntity, 'category', 'category.id = item.category_id')
      .addSelect('category.name', 'category_name')
      .where('item.id = :itemId AND item.company_id = :companyId', { itemId, companyId })
      .getRawAndEntities()
      .then(({ entities, raw }) => {
        const item = entities[0];
        if (!item) return null;
        const categoryName = raw[0] ? String((raw[0] as Record<string, unknown>).category_name) : '';
        return { ...item, categoryName };
      });
  }

  findItemBySku(companyId: string, sku: string): Promise<MasterMenuItemEntity | null> {
    return this.dataSource.getRepository(MasterMenuItemEntity).findOne({ where: { companyId, sku } });
  }

  /**
   * Authoritative item read for mutations: `SELECT … FOR UPDATE` inside the
   * caller's transaction so concurrent PATCHes serialize and each computes
   * `version + 1` from the other's committed state (PRD §8.6, AGENTS §3.4).
   */
  findItemForUpdate(
    manager: EntityManager,
    companyId: string,
    itemId: string,
  ): Promise<MasterMenuItemEntity | null> {
    return manager.getRepository(MasterMenuItemEntity).findOne({
      where: { id: itemId, companyId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  insertItem(
    manager: EntityManager,
    input: {
      companyId: string;
      categoryId: string;
      sku: string;
      name: string;
      description: string;
      defaultPriceMinor: string;
      currencyCode: string;
    },
  ): Promise<MasterMenuItemEntity> {
    const repo = manager.getRepository(MasterMenuItemEntity);
    return repo.save(repo.create({ ...input, status: 'ACTIVE', version: 1 }));
  }

  updateItem(
    manager: EntityManager,
    itemId: string,
    patch: Partial<{
      name: string;
      description: string;
      categoryId: string;
      defaultPriceMinor: string;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>,
  ): Promise<void> {
    return manager.getRepository(MasterMenuItemEntity).update({ id: itemId }, patch).then(() => undefined);
  }

  // ---- Fan-out discovery (read-only assignment joins) ------------------------

  /**
   * Active assignments of one item — the UPSERT/REMOVE fan-out targets. Must
   * run on the mutation transaction's manager so a concurrently committed
   * assignment cannot slip past the fan-out (AGENTS §3.4).
   */
  async listActiveAssignmentsForItem(manager: EntityManager, itemId: string): Promise<AssignmentTarget[]> {
    const rows = await manager
      .getRepository(OutletMenuAssignmentEntity)
      .find({ where: { menuItemId: itemId, active: true } });
    return rows.map((row) => ({
      outletId: row.outletId,
      assignmentId: row.id,
      priceOverrideMinor: row.priceOverrideMinor,
    }));
  }

  /** Active assignments of every item in a category (category rename fan-out). */
  async listActiveAssignmentsForCategory(
    manager: EntityManager,
    categoryId: string,
  ): Promise<Array<AssignmentTarget & { menuItemId: string }>> {
    const rows = await manager
      .getRepository(OutletMenuAssignmentEntity)
      .createQueryBuilder('assignment')
      .innerJoin(MasterMenuItemEntity, 'item', 'item.id = assignment.menu_item_id')
      .where('item.category_id = :categoryId AND assignment.active = true', { categoryId })
      .getMany();
    return rows.map((assignment) => ({
      outletId: assignment.outletId,
      assignmentId: assignment.id,
      priceOverrideMinor: assignment.priceOverrideMinor,
      menuItemId: assignment.menuItemId,
    }));
  }
}
