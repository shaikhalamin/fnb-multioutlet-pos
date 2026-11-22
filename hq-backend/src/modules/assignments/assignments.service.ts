import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { CatalogChangesService, type CatalogChange } from '../menu/catalog-changes.service.js';
import { MenuRepository } from '../menu/menu.repository.js';
import { OutletsRepository } from '../outlets/outlets.repository.js';
import type {
  AssignMenuItemLine,
  AssignMenuItemsResponse,
  AssignmentResultResponse,
  AssignmentResponse,
  AssignMenuRequest,
  OutletMenuResponse,
} from './dto/assignment.dto.js';
import { AssignmentsRepository } from './assignments.repository.js';

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/** One item's requested final assignment state inside a mutation. */
type AssignmentRequest = {
  menuItemId: string;
  active: boolean;
  /** `undefined` keeps the stored override, `null` clears it, a string sets it. */
  priceOverrideMinor?: string | null;
};

/** What a mutation did to one item. */
type AssignmentOutcome = {
  item: MasterMenuItemEntity;
  assignmentId: string;
  outcome: 'ASSIGNED' | 'UNCHANGED';
  active: boolean;
  priceOverrideMinor: string | null;
};

/**
 * Outlet assignment + price override governance (PRD FR-02, §7.2, §8.2).
 * The assignment upserts, their per-outlet revision bumps, the change-log
 * entries and the audit rows all commit in ONE transaction; no-op requests do
 * not burn a revision.
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

    const { revision, outcomes } = await this.dataSource.transaction((manager) =>
      this.commitAssignments(manager, companyId, outletId, actorId, [
        { menuItemId, active: request.active, priceOverrideMinor: request.priceOverrideMinor },
      ]),
    );
    const outcome = outcomes[0];
    if (!outcome) throw new Error('assignment mutation returned no outcome');
    return {
      outletId,
      menuItemId: outcome.item.id,
      assignmentId: outcome.assignmentId,
      active: outcome.active,
      defaultPriceMinor: outcome.item.defaultPriceMinor.toString(),
      priceOverrideMinor: outcome.priceOverrideMinor,
      effectivePriceMinor: (outcome.priceOverrideMinor ?? outcome.item.defaultPriceMinor).toString(),
      currencyCode: outcome.item.currencyCode,
      catalogRevision: revision,
    };
  }

  async unassign(outletId: string, menuItemId: string, actorId: string): Promise<AssignmentResponse> {
    return this.assign(outletId, menuItemId, { active: false }, actorId);
  }

  /**
   * Activates several items on one outlet as a single atomic request
   * (FR-02): either every item is assigned — each with its own UPSERT catalog
   * revision — or, if any item is rejected, nothing is committed. Each line
   * may also set a price override (omitted keeps the stored one, null clears
   * it — same semantics as the single-item PUT). Items already assigned in
   * exactly this state are reported `UNCHANGED` and consume no revision, so
   * retrying a delivered request is harmless.
   */
  async assignMany(
    outletId: string,
    lines: AssignMenuItemLine[],
    actorId: string,
  ): Promise<AssignMenuItemsResponse> {
    const companyId = await resolveCompanyId(this.dataSource);
    const outlet = await this.outlets.findById(companyId, outletId);
    if (!outlet) throw new ApiException('NOT_FOUND', 'Outlet not found.', 404);
    for (const line of lines) {
      if (line.priceOverrideMinor) {
        this.assertMoneyBound(line.priceOverrideMinor);
      }
    }

    const { revision, outcomes } = await this.dataSource.transaction((manager) =>
      this.commitAssignments(
        manager,
        companyId,
        outletId,
        actorId,
        lines.map((line) => ({
          menuItemId: line.menuItemId,
          active: true,
          priceOverrideMinor: line.priceOverrideMinor,
        })),
      ),
    );

    const items: AssignmentResultResponse[] = outcomes.map((outcome) => ({
      menuItemId: outcome.item.id,
      assignmentId: outcome.assignmentId,
      outcome: outcome.outcome,
      defaultPriceMinor: outcome.item.defaultPriceMinor.toString(),
      priceOverrideMinor: outcome.priceOverrideMinor,
      effectivePriceMinor: (outcome.priceOverrideMinor ?? outcome.item.defaultPriceMinor).toString(),
      currencyCode: outcome.item.currencyCode,
    }));
    return {
      outletId,
      catalogRevision: revision,
      assignedCount: items.filter((item) => item.outcome === 'ASSIGNED').length,
      unchangedCount: items.filter((item) => item.outcome === 'UNCHANGED').length,
      items,
    };
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

  /**
   * Applies assignment requests to one outlet inside the caller's transaction
   * and returns what happened to each item plus the outlet's resulting
   * catalog revision.
   *
   * Locks are taken in a fixed order — item rows in item-ID order, then the
   * outlet's revision row, then its assignment rows. A concurrent edit/archive
   * of an item holds the same item lock while it discovers its fan-out
   * targets, and every other assignment mutation on the outlet takes the same
   * revision lock first, so both serialize with this request instead of
   * committing against stale state (PRD §8.2 rule 5, §8.6). The locked rows
   * are the source of truth: item status and price are read after the locks.
   */
  private async commitAssignments(
    manager: EntityManager,
    companyId: string,
    outletId: string,
    actorId: string,
    requests: AssignmentRequest[],
  ): Promise<{ revision: string; outcomes: AssignmentOutcome[] }> {
    const ordered = [...requests].sort((a, b) => (a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0));

    const lockedItems = await this.menu.findItemsForUpdate(
      manager,
      companyId,
      ordered.map((request) => request.menuItemId),
    );
    const itemById = new Map(lockedItems.map((item) => [item.id, item]));
    const resolved: Array<{ request: AssignmentRequest; item: MasterMenuItemEntity }> = [];
    const missing: string[] = [];
    for (const request of ordered) {
      const item = itemById.get(request.menuItemId);
      if (item) resolved.push({ request, item });
      else missing.push(request.menuItemId);
    }
    if (missing.length > 0) {
      throw new ApiException('NOT_FOUND', 'Menu item not found.', 404, { menuItemIds: missing });
    }
    const inactive = resolved.filter(({ request, item }) => request.active && item.status !== 'ACTIVE');
    if (inactive.length > 0) {
      // All-or-nothing: one archived item rejects the whole request before a single row is written.
      throw new ApiException('ITEM_INACTIVE', 'Archived items cannot be actively assigned.', 422, {
        menuItemIds: inactive.map(({ item }) => item.id),
        itemStatus: 'ARCHIVED',
      });
    }

    const revisionRow = await this.outlets.lockCatalogRevision(manager, outletId);
    if (!revisionRow) throw new Error(`catalog revision row missing for outlet ${outletId}`);
    const existingRows = await this.assignments.findAssignmentsForUpdate(
      manager,
      outletId,
      resolved.map(({ item }) => item.id),
    );
    const existingByItem = new Map(existingRows.map((row) => [row.menuItemId, row]));

    const categoryIds = [...new Set(resolved.map(({ item }) => item.categoryId))];
    const outcomes: AssignmentOutcome[] = [];
    const changes: CatalogChange[] = [];
    const audits: AuditEvent[] = [];
    // Fetched once, and only once an item actually changes.
    let categoryNames: Promise<Map<string, string>> | undefined;
    for (const { request, item } of resolved) {
      const existing = existingByItem.get(item.id) ?? null;
      // `undefined` keeps the current override; explicit `null` clears it.
      const priceOverrideMinor =
        request.priceOverrideMinor === undefined
          ? (existing?.priceOverrideMinor ?? null)
          : request.priceOverrideMinor;
      // No-op guard: identical state must not consume a catalog revision.
      if (existing && existing.active === request.active && existing.priceOverrideMinor === priceOverrideMinor) {
        outcomes.push({
          item,
          assignmentId: existing.id,
          outcome: 'UNCHANGED',
          active: existing.active,
          priceOverrideMinor: existing.priceOverrideMinor,
        });
        continue;
      }

      let assignmentId: string;
      if (existing) {
        await this.assignments.updateAssignment(manager, existing.id, {
          active: request.active,
          priceOverrideMinor,
          version: existing.version + 1,
        });
        assignmentId = existing.id;
      } else {
        const created = await this.assignments.insertAssignment(manager, {
          outletId,
          menuItemId: item.id,
          priceOverrideMinor,
          active: request.active,
        });
        assignmentId = created.id;
      }
      outcomes.push({
        item,
        assignmentId,
        outcome: 'ASSIGNED',
        active: request.active,
        priceOverrideMinor,
      });

      // One canonical change entry describing the final effective state (§8.2).
      changes.push({
        outletId,
        action: request.active ? 'UPSERT' : 'REMOVE',
        payload: request.active
          ? upsertPayload(
              item,
              assignmentId,
              priceOverrideMinor,
              await (categoryNames ??= this.menu.findCategoryNames(manager, categoryIds)),
            )
          : { assignmentId, menuItemId: item.id },
      });
      audits.push({
        actorType: 'USER',
        actorId,
        action: request.active ? 'assignment.assigned' : 'assignment.unassigned',
        entityType: 'outlet_menu_assignment',
        entityId: assignmentId,
        metadata: { outletId, menuItemId: item.id, priceOverrideMinor },
      });
    }

    if (changes.length === 0) {
      return { revision: revisionRow.currentRevision, outcomes };
    }
    const appended = await this.catalogChanges.appendChanges(manager, changes);
    if (appended.length !== changes.length) {
      throw new Error('catalog change insert returned no row');
    }
    for (const event of audits) await this.audit.record(event, manager);
    return { revision: appended.at(-1)?.revision ?? revisionRow.currentRevision, outcomes };
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

/** Full §8.3-style UPSERT snapshot: reproducible, no current-state fetch later. */
function upsertPayload(
  item: MasterMenuItemEntity,
  assignmentId: string,
  override: string | null,
  categoryNames: Map<string, string>,
): Record<string, unknown> {
  return {
    assignmentId,
    menuItemId: item.id,
    sku: item.sku,
    name: item.name,
    description: item.description,
    category: categoryNames.get(item.categoryId) ?? '',
    unitPriceMinor: (override ?? item.defaultPriceMinor).toString(),
    currencyCode: item.currencyCode,
    active: true,
    itemVersion: item.version,
  };
}
