import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { CompanyEntity } from '../../database/entities/company.entity.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { MenuCategoryEntity } from '../../database/entities/menu-category.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { CatalogChangesService, type CatalogChange } from './catalog-changes.service.js';
import type {
  CategoryResponse,
  CreateCategoryRequest,
  CreateMenuItemRequest,
  MenuItemResponse,
  UpdateCategoryRequest,
  UpdateMenuItemRequest,
} from './dto/menu.dto.js';
import { MenuRepository, type MenuItemWithCategory } from './menu.repository.js';

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Master menu governance (PRD FR-01, §8.2). Every item/category mutation and
 * its per-outlet change fan-out commit in ONE transaction: the admin response
 * returns only after the durable distribution record exists.
 */
@Injectable()
export class MenuService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly menu: MenuRepository,
    private readonly catalogChanges: CatalogChangesService,
    private readonly audit: AuditService,
  ) {}

  // ---- Categories -----------------------------------------------------------

  async listCategories(): Promise<CategoryResponse[]> {
    const companyId = await resolveCompanyId(this.dataSource);
    const categories = await this.menu.listCategories(companyId);
    return categories.map(toCategoryResponse);
  }

  async getCategory(categoryId: string): Promise<CategoryResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const category = await this.menu.findCategory(companyId, categoryId);
    if (!category) throw new ApiException('NOT_FOUND', 'Category not found.', 404);
    return toCategoryResponse(category);
  }

  async createCategory(request: CreateCategoryRequest, actorId: string): Promise<CategoryResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const duplicate = await this.menu.findCategoryByName(companyId, request.name);
    if (duplicate) {
      throw new ApiException('CONFLICT', 'A category with this name already exists.', 409, {
        name: request.name,
      });
    }
    const category = await this.dataSource.transaction(async (manager) => {
      const created = await this.menu.insertCategory(manager, {
        companyId,
        name: request.name,
        sortOrder: request.sortOrder ?? 0,
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'menu.category_created',
          entityType: 'menu_category',
          entityId: created.id,
          metadata: { name: created.name },
        },
        manager,
      );
      return created;
    });
    return toCategoryResponse(category);
  }

  async updateCategory(
    categoryId: string,
    request: UpdateCategoryRequest,
    actorId: string,
  ): Promise<CategoryResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const category = await this.menu.findCategory(companyId, categoryId);
    if (!category) throw new ApiException('NOT_FOUND', 'Category not found.', 404);

    if (request.name && request.name !== category.name) {
      const duplicate = await this.menu.findCategoryByName(companyId, request.name);
      if (duplicate) {
        throw new ApiException('CONFLICT', 'A category with this name already exists.', 409, {
          name: request.name,
        });
      }
    }
    if (request.status === 'ARCHIVED' && category.status === 'ACTIVE') {
      const activeItems = await this.menu.countActiveItemsInCategory(categoryId);
      if (activeItems > 0) {
        throw new ApiException(
          'UNPROCESSABLE_ENTITY',
          'Archive or move the active items out of this category first.',
          422,
          { activeItems },
        );
      }
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      await this.menu.updateCategory(manager, categoryId, {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.sortOrder !== undefined ? { sortOrder: request.sortOrder } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
      });
      // A rename changes the snapshotted category name on affected outlets —
      // fan out inside the SAME transaction (PRD §8.2: a menu change never
      // commits without its durable distribution record).
      if (request.name && request.name !== category.name) {
        await this.fanoutCategoryRename(manager, categoryId);
      }
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'menu.category_updated',
          entityType: 'menu_category',
          entityId: categoryId,
          metadata: { ...request },
        },
        manager,
      );
      return category;
    });

    const fresh = await this.menu.findCategory(companyId, categoryId);
    return toCategoryResponse(fresh ?? updated);
  }

  // ---- Master items ---------------------------------------------------------

  async listItems(query: {
    categoryId?: string;
    status?: 'ACTIVE' | 'ARCHIVED';
    q?: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: MenuItemResponse[]; nextCursor: string | undefined }> {
    const companyId = await resolveCompanyId(this.dataSource);
    const decoded = decodeCursor(query.cursor);
    const page = await this.menu.listItems({
      companyId,
      categoryId: query.categoryId,
      status: query.status,
      search: query.q,
      limit: query.limit,
      cursor: decoded,
    });
    return { items: page.items.map(toMenuItemResponse), nextCursor: page.nextCursor };
  }

  async getItem(itemId: string): Promise<MenuItemResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const item = await this.menu.findItem(companyId, itemId);
    if (!item) throw new ApiException('NOT_FOUND', 'Menu item not found.', 404);
    return toMenuItemResponse(item);
  }

  async createItem(request: CreateMenuItemRequest, actorId: string): Promise<MenuItemResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    await this.assertCurrencyMatchesCompany(request.currencyCode);

    const duplicate = await this.menu.findItemBySku(companyId, request.sku);
    if (duplicate) {
      throw new ApiException('CONFLICT', 'An item with this SKU already exists.', 409, {
        sku: request.sku,
      });
    }
    const category = await this.menu.findCategory(companyId, request.categoryId);
    if (!category || category.status !== 'ACTIVE') {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Category is missing or archived.', 422, {
        categoryId: request.categoryId,
      });
    }
    this.assertMoneyBound(request.defaultPriceMinor, 'defaultPriceMinor');

    // No assignments exist for a brand-new item, so there is nothing to fan
    // out yet — the first PUT assignment generates the UPSERT change.
    const item = await this.dataSource.transaction(async (manager) => {
      const created = await this.menu.insertItem(manager, {
        companyId,
        categoryId: request.categoryId,
        sku: request.sku,
        name: request.name,
        description: request.description ?? '',
        defaultPriceMinor: request.defaultPriceMinor,
        currencyCode: request.currencyCode,
      });
      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: 'menu.item_created',
          entityType: 'master_menu_item',
          entityId: created.id,
          metadata: { sku: created.sku, defaultPriceMinor: created.defaultPriceMinor },
        },
        manager,
      );
      return created;
    });
    return toMenuItemResponse({ ...item, categoryName: category.name });
  }

  async updateItem(
    itemId: string,
    request: UpdateMenuItemRequest,
    actorId: string,
  ): Promise<MenuItemResponse> {
    const companyId = await resolveCompanyId(this.dataSource);

    const item = await this.dataSource.transaction(async (manager) => {
      // Lock the item row FOR UPDATE (PRD §8.6): concurrent PATCHes serialize
      // here and each computes version + 1 from the other's committed state —
      // a blind read-then-write would lose updates.
      const locked = await this.menu.findItemForUpdate(manager, companyId, itemId);
      if (!locked) throw new ApiException('NOT_FOUND', 'Menu item not found.', 404);

      if (request.defaultPriceMinor !== undefined) {
        this.assertMoneyBound(request.defaultPriceMinor, 'defaultPriceMinor');
      }
      if (request.categoryId && request.categoryId !== locked.categoryId) {
        const category = await this.menu.findCategory(companyId, request.categoryId);
        if (!category || category.status !== 'ACTIVE') {
          throw new ApiException('UNPROCESSABLE_ENTITY', 'Category is missing or archived.', 422, {
            categoryId: request.categoryId,
          });
        }
      }

      const archiving = request.status === 'ARCHIVED' && locked.status === 'ACTIVE';
      const nextVersion = locked.version + 1;
      const newName = request.name ?? locked.name;
      const newDescription = request.description ?? locked.description;
      const newCategoryId = request.categoryId ?? locked.categoryId;
      const newPrice = request.defaultPriceMinor ?? locked.defaultPriceMinor;
      const newStatus = request.status ?? locked.status;

      await this.menu.updateItem(manager, itemId, {
        name: newName,
        description: newDescription,
        categoryId: newCategoryId,
        defaultPriceMinor: newPrice,
        status: newStatus,
        version: nextVersion,
      });

      // Discover fan-out targets on the SAME transaction and append per-outlet
      // changes atomically (PRD §8.2): archived items REMOVE, otherwise UPSERT
      // the new snapshot.
      const targets = await this.menu.listActiveAssignmentsForItem(manager, itemId);
      if (targets.length > 0) {
        const action: 'UPSERT' | 'REMOVE' = archiving ? 'REMOVE' : 'UPSERT';
        const changes: CatalogChange[] = [];
        for (const target of targets) {
          changes.push({
            outletId: target.outletId,
            action,
            payload:
              action === 'REMOVE'
                ? this.removePayload(itemId, target.assignmentId)
                : await this.upsertPayload(manager, itemId, target, {
                    name: newName,
                    description: newDescription,
                    categoryId: newCategoryId,
                    defaultPriceMinor: newPrice,
                    version: nextVersion,
                  }),
          });
        }
        await this.catalogChanges.appendChanges(manager, changes);
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: archiving ? 'menu.item_archived' : 'menu.item_updated',
          entityType: 'master_menu_item',
          entityId: itemId,
          metadata: { sku: locked.sku, version: nextVersion, fanoutOutlets: targets.length },
        },
        manager,
      );
      return locked;
    });

    const fresh = await this.menu.findItem(companyId, itemId);
    return toMenuItemResponse(fresh ?? { ...item, categoryName: '' });
  }

  // ---- helpers --------------------------------------------------------------

  /** Full §8.3-style UPSERT snapshot: reproducible, no current-state fetch later. */
  private async upsertPayload(
    manager: EntityManager,
    itemId: string,
    target: { assignmentId: string; priceOverrideMinor: string | null },
    snapshot: {
      name: string;
      description: string;
      categoryId: string;
      defaultPriceMinor: string;
      version: number;
    },
  ): Promise<Record<string, unknown>> {
    const item = await manager.getRepository(MasterMenuItemEntity).findOne({ where: { id: itemId } });
    const category = await manager
      .getRepository(MenuCategoryEntity)
      .findOne({ where: { id: snapshot.categoryId } });
    if (!item || !category) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Item or category disappeared mid-transaction.', 422);
    }
    return {
      assignmentId: target.assignmentId,
      sku: item.sku,
      name: snapshot.name,
      description: snapshot.description,
      category: category.name,
      unitPriceMinor: (target.priceOverrideMinor ?? snapshot.defaultPriceMinor).toString(),
      currencyCode: item.currencyCode,
      active: true,
      itemVersion: snapshot.version,
    };
  }

  private removePayload(menuItemId: string, assignmentId: string): Record<string, unknown> {
    return { assignmentId, menuItemId };
  }

  /** Runs inside the caller's mutation transaction — never opens its own. */
  private async fanoutCategoryRename(manager: EntityManager, categoryId: string): Promise<void> {
    const targets = await this.menu.listActiveAssignmentsForCategory(manager, categoryId);
    if (targets.length === 0) return;
    const [items, category] = await Promise.all([
      manager.getRepository(MasterMenuItemEntity).find({ where: { categoryId } }),
      manager.getRepository(MenuCategoryEntity).findOne({ where: { id: categoryId } }),
    ]);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const changes: CatalogChange[] = [];
    for (const target of targets) {
      const item = itemsById.get(target.menuItemId);
      if (!item) continue;
      changes.push({
        outletId: target.outletId,
        action: 'UPSERT',
        payload: {
          assignmentId: target.assignmentId,
          sku: item.sku,
          name: item.name,
          description: item.description,
          category: category?.name ?? '',
          unitPriceMinor: (target.priceOverrideMinor ?? item.defaultPriceMinor).toString(),
          currencyCode: item.currencyCode,
          active: true,
          itemVersion: item.version,
        },
      });
    }
    if (changes.length > 0) await this.catalogChanges.appendChanges(manager, changes);
  }

  private async assertCurrencyMatchesCompany(currencyCode: string): Promise<void> {
    const company = await this.dataSource.getRepository(CompanyEntity).findOne({ where: {} });
    if (company && company.currencyCode !== currencyCode) {
      throw new ApiException(
        'UNPROCESSABLE_ENTITY',
        'Currency must match the company currency in V1.',
        422,
        { companyCurrency: company.currencyCode, provided: currencyCode },
      );
    }
  }

  private assertMoneyBound(value: string, field: string): void {
    if (BigInt(value) > BIGINT_MAX) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Amount exceeds bigint range.', 422, { field, value });
    }
  }
}

function decodeCursor(raw: string | undefined): { createdAt: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return undefined;
    return parsed as { createdAt: string; id: string };
  } catch {
    return undefined;
  }
}

function toCategoryResponse(category: MenuCategoryEntity): CategoryResponse {
  return {
    id: category.id,
    name: category.name,
    sortOrder: category.sortOrder,
    status: category.status,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function toMenuItemResponse(item: MenuItemWithCategory): MenuItemResponse {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    description: item.description,
    categoryId: item.categoryId,
    categoryName: item.categoryName,
    defaultPriceMinor: item.defaultPriceMinor.toString(),
    currencyCode: item.currencyCode,
    status: item.status,
    version: item.version,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
