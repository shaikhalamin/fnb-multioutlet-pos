import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MenuCategoryEntity } from '../../database/entities/menu-category.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { CatalogChangesService } from '../menu/catalog-changes.service.js';
import { MenuRepository } from '../menu/menu.repository.js';
import { OutletsRepository } from '../outlets/outlets.repository.js';
import type { AssignMenuRequest, AssignmentResponse, OutletMenuResponse } from './dto/assignment.dto.js';
import { AssignmentsRepository } from './assignments.repository.js';

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Outlet assignment + price override governance (PRD FR-02, §7.2, §8.2).
 * The assignment upsert, its per-outlet revision bump, the change-log entry
 * and the audit row all commit in ONE transaction; no-op requests do not
 * burn a revision.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly assignments: AssignmentsRepository,
    private readonly outlets: OutletsRepository,
    private readonly menu: MenuRepository,
    private readonly catalogChanges: CatalogChangesService,
    private readonly audit: AuditService,
  ) {}

  async assign(
    outletId: string,
    menuItemId: string,
    request: AssignMenuRequest,
    actorId: string,
  ): Promise<AssignmentResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    const item = await this.menu.findItem(companyId, menuItemId);
    if (!item) throw new ApiException('NOT_FOUND', 'Menu item not found.', 404);

    if (request.active && item.status !== 'ACTIVE') {
      throw new ApiException('ITEM_INACTIVE', 'Archived items cannot be actively assigned.', 422, {
        menuItemId,
        itemStatus: item.status,
      });
    }
    if (request.priceOverrideMinor) {
      this.assertMoneyBound(request.priceOverrideMinor);
    }

    const existing = await this.assignments.findAssignment(outletId, menuItemId);
    // `undefined` keeps the current override; explicit `null` clears it.
    const nextOverride =
      request.priceOverrideMinor === undefined
        ? (existing?.priceOverrideMinor ?? null)
        : request.priceOverrideMinor;

    // No-op guard: identical state must not consume a catalog revision.
    if (existing && existing.active === request.active && existing.priceOverrideMinor === nextOverride) {
      return this.toAssignmentResponse(outletId, menuItemId, existing, item, outlet.catalogRevision);
    }

    const revision = await this.dataSource.transaction(async (manager) => {
      let assignmentId: string;
      if (existing) {
        await this.assignments.updateAssignment(manager, existing.id, {
          active: request.active,
          priceOverrideMinor: nextOverride,
          version: existing.version + 1,
        });
        assignmentId = existing.id;
      } else {
        const created = await this.assignments.insertAssignment(manager, {
          outletId,
          menuItemId,
          priceOverrideMinor: nextOverride,
          active: request.active,
        });
        assignmentId = created.id;
      }

      // One canonical change entry describing the final effective state (§8.2).
      const [change] = await this.catalogChanges.appendChanges(manager, [
        {
          outletId,
          action: request.active ? 'UPSERT' : 'REMOVE',
          payload: request.active
            ? await this.buildUpsertPayload(manager, item, assignmentId, nextOverride)
            : { assignmentId, menuItemId },
        },
      ]);
      if (!change) throw new Error('catalog change insert returned no row');

      await this.audit.record(
        {
          actorType: 'USER',
          actorId,
          action: request.active ? 'assignment.assigned' : 'assignment.unassigned',
          entityType: 'outlet_menu_assignment',
          entityId: assignmentId,
          metadata: { outletId, menuItemId, priceOverrideMinor: nextOverride },
        },
        manager,
      );
      return change.revision;
    });

    const assignmentAfter = (await this.assignments.findAssignment(outletId, menuItemId)) as {
      id: string;
      active: boolean;
      priceOverrideMinor: string | null;
    };
    return this.toAssignmentResponse(outletId, menuItemId, assignmentAfter, item, revision);
  }

  async unassign(outletId: string, menuItemId: string, actorId: string): Promise<AssignmentResponse> {
    return this.assign(outletId, menuItemId, { active: false }, actorId);
  }

  async listOutletMenu(outletId: string): Promise<OutletMenuResponse[]> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    const rows = await this.assignments.listOutletAssignments(outletId);
    return rows.map((row) => ({
      assignmentId: row.assignmentId,
      menuItemId: row.menuItemId,
      sku: row.sku,
      name: row.name,
      categoryName: row.categoryName,
      itemStatus: row.itemStatus,
      active: row.active,
      defaultPriceMinor: row.defaultPriceMinor,
      priceOverrideMinor: row.priceOverrideMinor,
      effectivePriceMinor: (row.priceOverrideMinor ?? row.defaultPriceMinor).toString(),
      currencyCode: row.currencyCode,
    }));
  }

  private async buildUpsertPayload(
    manager: EntityManager,
    item: {
      id: string;
      sku: string;
      name: string;
      description: string;
      categoryId: string;
      defaultPriceMinor: string;
      currencyCode: string;
      version: number;
    },
    assignmentId: string,
    override: string | null,
  ): Promise<Record<string, unknown>> {
    const category = await manager
      .getRepository(MenuCategoryEntity)
      .findOne({ where: { id: item.categoryId } });
    return {
      assignmentId,
      sku: item.sku,
      name: item.name,
      description: item.description,
      category: category?.name ?? '',
      unitPriceMinor: (override ?? item.defaultPriceMinor).toString(),
      currencyCode: item.currencyCode,
      active: true,
      itemVersion: item.version,
    };
  }

  private toAssignmentResponse(
    outletId: string,
    menuItemId: string,
    assignment: { id: string; active: boolean; priceOverrideMinor: string | null },
    item: { defaultPriceMinor: string; currencyCode: string },
    catalogRevision: string,
  ): AssignmentResponse {
    return {
      outletId,
      menuItemId,
      assignmentId: assignment.id,
      active: assignment.active,
      defaultPriceMinor: item.defaultPriceMinor.toString(),
      priceOverrideMinor: assignment.priceOverrideMinor,
      effectivePriceMinor: (assignment.priceOverrideMinor ?? item.defaultPriceMinor).toString(),
      currencyCode: item.currencyCode,
      catalogRevision,
    };
  }

  private assertMoneyBound(value: string): void {
    if (BigInt(value) > BIGINT_MAX) {
      throw new ApiException('UNPROCESSABLE_ENTITY', 'Amount exceeds bigint range.', 422, {
        field: 'priceOverrideMinor',
        value,
      });
    }
  }
}
