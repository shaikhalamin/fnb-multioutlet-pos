import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { MasterMenuItemEntity } from '../../database/entities/master-menu-item.entity.js';
import { OutletMenuAssignmentEntity } from '../../database/entities/outlet-menu-assignment.entity.js';
import { CatalogChangesService } from '../menu/catalog-changes.service.js';
import { MenuRepository } from '../menu/menu.repository.js';
import { OutletsRepository } from '../outlets/outlets.repository.js';
import { AssignmentsRepository } from './assignments.repository.js';
import { AssignmentsService } from './assignments.service.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Assignment mutation orchestration (FR-02): lock order, deterministic
 * ordering, the no-op guard and the all-or-nothing rejection. The real
 * transaction/locking behaviour runs against PostgreSQL in
 * `test/assignments-bulk.e2e-spec.ts`.
 */
const COMPANY = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const OUTLET = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';
const ITEM_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeItem(id: string, patch: Partial<MasterMenuItemEntity> = {}): MasterMenuItemEntity {
  return {
    id,
    companyId: COMPANY,
    categoryId: CATEGORY,
    sku: `SKU-${id.slice(0, 4).toUpperCase()}`,
    name: `Item ${id.slice(0, 4).toUpperCase()}`,
    description: '',
    defaultPriceMinor: '1000',
    currencyCode: 'USD',
    status: 'ACTIVE',
    version: 1,
    ...patch,
  } as MasterMenuItemEntity;
}

function makeAssignment(menuItemId: string, patch: Partial<OutletMenuAssignmentEntity> = {}) {
  return {
    id: `asg-${menuItemId.slice(0, 4)}`,
    outletId: OUTLET,
    menuItemId,
    priceOverrideMinor: null,
    active: true,
    version: 1,
    ...patch,
  } as OutletMenuAssignmentEntity;
}

function line(menuItemId: string, priceOverrideMinor?: string | null) {
  return { menuItemId, ...(priceOverrideMinor === undefined ? {} : { priceOverrideMinor }) };
}

function makeService(
  items: MasterMenuItemEntity[],
  options: { existing?: OutletMenuAssignmentEntity[]; revision?: string } = {},
) {
  const revision = options.revision ?? '41';
  const dataSource = {
    getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue({ id: COMPANY }) }),
    transaction: vi.fn(async (run: (manager: unknown) => Promise<unknown>) => run({})),
  };
  const menu = {
    findItem: vi.fn(async (_companyId: string, id: string) => items.find((item) => item.id === id) ?? null),
    // The repository locks in the order it is asked for.
    findItemsForUpdate: vi.fn(async (_manager: unknown, _companyId: string, ids: string[]) =>
      ids.flatMap((id) => items.filter((item) => item.id === id)),
    ),
    findCategoryNames: vi.fn().mockResolvedValue(new Map([[CATEGORY, 'Burgers']])),
  };
  const outlets = {
    findById: vi.fn().mockResolvedValue({ id: OUTLET, catalogRevision: revision }),
    lockCatalogRevision: vi.fn().mockResolvedValue({ outletId: OUTLET, currentRevision: revision }),
  };
  const assignments = {
    findAssignmentsForUpdate: vi.fn().mockResolvedValue(options.existing ?? []),
    insertAssignment: vi.fn(async (_manager: unknown, input: Record<string, unknown>) => ({
      id: `asg-${String(input.menuItemId).slice(0, 4)}`,
      ...input,
      version: 1,
    })),
    updateAssignment: vi.fn().mockResolvedValue(undefined),
  };
  const catalogChanges = {
    appendChanges: vi.fn(async (_manager: unknown, changes: Array<Record<string, unknown>>) =>
      changes.map((change, index) => ({ revision: String(Number(revision) + index + 1), ...change })),
    ),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new AssignmentsService(
    dataSource as unknown as DataSource,
    assignments as unknown as AssignmentsRepository,
    outlets as unknown as OutletsRepository,
    menu as unknown as MenuRepository,
    catalogChanges as unknown as CatalogChangesService,
    audit as unknown as AuditService,
  );
  return { service, menu, outlets, assignments, catalogChanges, audit };
}

describe('AssignmentsService', () => {
  it('locks items in item-ID order whatever order the client sent, and reports results in that order', async () => {
    const { service, menu, assignments } = makeService([makeItem(ITEM_A), makeItem(ITEM_B), makeItem(ITEM_C)]);

    const result = await service.assignMany(OUTLET, [line(ITEM_C), line(ITEM_A), line(ITEM_B)], ACTOR);

    expect(menu.findItemsForUpdate).toHaveBeenCalledWith(expect.anything(), COMPANY, [ITEM_A, ITEM_B, ITEM_C]);
    expect(assignments.insertAssignment.mock.calls.map((call) => call[1].menuItemId)).toEqual([
      ITEM_A,
      ITEM_B,
      ITEM_C,
    ]);
    expect(result.items.map((row) => row.menuItemId)).toEqual([ITEM_A, ITEM_B, ITEM_C]);
    expect(result).toMatchObject({
      outletId: OUTLET,
      catalogRevision: '44',
      assignedCount: 3,
      unchangedCount: 0,
    });
  });

  it('takes the revision row lock and the assignment locks only after the item locks', async () => {
    const { service, menu, outlets, assignments } = makeService([makeItem(ITEM_A)]);

    await service.assignMany(OUTLET, [line(ITEM_A)], ACTOR);

    const [items] = menu.findItemsForUpdate.mock.invocationCallOrder;
    const [revision] = outlets.lockCatalogRevision.mock.invocationCallOrder;
    const [rows] = assignments.findAssignmentsForUpdate.mock.invocationCallOrder;
    expect(items).toBeLessThan(revision);
    expect(revision).toBeLessThan(rows);
  });

  it('rejects the whole batch on an archived item before taking the outlet lock or writing anything', async () => {
    const archived = makeItem(ITEM_B, { status: 'ARCHIVED' });
    const { service, outlets, assignments, catalogChanges, audit } = makeService([
      makeItem(ITEM_A),
      archived,
      makeItem(ITEM_C),
    ]);

    await expect(service.assignMany(OUTLET, [line(ITEM_A), line(ITEM_B), line(ITEM_C)], ACTOR)).rejects.toMatchObject({
      code: 'ITEM_INACTIVE',
      details: { menuItemIds: [ITEM_B], itemStatus: 'ARCHIVED' },
    });

    expect(outlets.lockCatalogRevision).not.toHaveBeenCalled();
    expect(assignments.insertAssignment).not.toHaveBeenCalled();
    expect(assignments.updateAssignment).not.toHaveBeenCalled();
    expect(catalogChanges.appendChanges).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reports the ids it could not find and writes nothing', async () => {
    const ghost = '55555555-5555-4555-8555-555555555555';
    const { service, outlets, assignments } = makeService([makeItem(ITEM_A), makeItem(ITEM_C)]);

    await expect(service.assignMany(OUTLET, [line(ITEM_C), line(ghost), line(ITEM_A)], ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { menuItemIds: [ghost] },
    });

    expect(outlets.lockCatalogRevision).not.toHaveBeenCalled();
    expect(assignments.insertAssignment).not.toHaveBeenCalled();
  });

  it('leaves already-assigned items untouched: no write, no revision, no audit', async () => {
    const assigned = makeAssignment(ITEM_B, { priceOverrideMinor: '1200', version: 4 });
    const { service, assignments, catalogChanges, audit } = makeService(
      [makeItem(ITEM_A), makeItem(ITEM_B)],
      { existing: [assigned] },
    );

    const result = await service.assignMany(OUTLET, [line(ITEM_A), line(ITEM_B)], ACTOR);

    expect(result.items.map((row) => [row.menuItemId, row.outcome])).toEqual([
      [ITEM_A, 'ASSIGNED'],
      [ITEM_B, 'UNCHANGED'],
    ]);
    expect(result.items[1]).toMatchObject({
      assignmentId: assigned.id,
      priceOverrideMinor: '1200',
      effectivePriceMinor: '1200',
    });
    expect(assignments.updateAssignment).not.toHaveBeenCalled();
    expect(assignments.insertAssignment).toHaveBeenCalledTimes(1);
    expect(catalogChanges.appendChanges).toHaveBeenCalledTimes(1);
    expect(catalogChanges.appendChanges.mock.calls[0][1]).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: 'assignment.assigned',
      entityId: `asg-aaaa`,
      metadata: { outletId: OUTLET, menuItemId: ITEM_A, priceOverrideMinor: null },
    });
  });

  it('answers an all-unchanged batch with the current revision and emits nothing', async () => {
    const { service, catalogChanges, audit } = makeService([makeItem(ITEM_A)], {
      existing: [makeAssignment(ITEM_A)],
      revision: '7',
    });

    const result = await service.assignMany(OUTLET, [line(ITEM_A)], ACTOR);

    expect(result).toMatchObject({ catalogRevision: '7', assignedCount: 0, unchangedCount: 1 });
    expect(catalogChanges.appendChanges).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reactivates a soft-unassigned row in place, bumping its version and keeping its override', async () => {
    const tombstone = makeAssignment(ITEM_A, { active: false, priceOverrideMinor: '950', version: 3 });
    const { service, assignments, catalogChanges } = makeService([makeItem(ITEM_A)], {
      existing: [tombstone],
    });

    const result = await service.assignMany(OUTLET, [line(ITEM_A)], ACTOR);

    expect(assignments.updateAssignment).toHaveBeenCalledWith(expect.anything(), tombstone.id, {
      active: true,
      priceOverrideMinor: '950',
      version: 4,
    });
    expect(assignments.insertAssignment).not.toHaveBeenCalled();
    expect(catalogChanges.appendChanges.mock.calls[0][1][0]).toMatchObject({
      outletId: OUTLET,
      action: 'UPSERT',
      payload: { assignmentId: tombstone.id, menuItemId: ITEM_A, unitPriceMinor: '950', itemVersion: 1 },
    });
    expect(result.items[0]).toMatchObject({ assignmentId: tombstone.id, effectivePriceMinor: '950' });
  });

  it('sets a line price override on a brand-new assignment and snapshots it into the revision payload', async () => {
    const { service, assignments, catalogChanges, audit } = makeService([makeItem(ITEM_A), makeItem(ITEM_B)]);

    const result = await service.assignMany(OUTLET, [line(ITEM_A, '1500'), line(ITEM_B)], ACTOR);

    expect(assignments.insertAssignment).toHaveBeenNthCalledWith(1, expect.anything(), {
      outletId: OUTLET,
      menuItemId: ITEM_A,
      priceOverrideMinor: '1500',
      active: true,
    });
    expect(assignments.insertAssignment).toHaveBeenNthCalledWith(2, expect.anything(), {
      outletId: OUTLET,
      menuItemId: ITEM_B,
      priceOverrideMinor: null,
      active: true,
    });
    expect(catalogChanges.appendChanges.mock.calls[0][1][0]).toMatchObject({
      action: 'UPSERT',
      payload: { menuItemId: ITEM_A, unitPriceMinor: '1500' },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      metadata: { outletId: OUTLET, menuItemId: ITEM_A, priceOverrideMinor: '1500' },
    });
    expect(result.items[0]).toMatchObject({
      outcome: 'ASSIGNED',
      priceOverrideMinor: '1500',
      effectivePriceMinor: '1500',
    });
    expect(result.items[1]).toMatchObject({ priceOverrideMinor: null, effectivePriceMinor: '1000' });
  });

  it('updates an active assignment whose line asks for a different price: ASSIGNED, version bumped, one revision', async () => {
    const existing = makeAssignment(ITEM_A, { priceOverrideMinor: '1200', version: 6 });
    const { service, assignments } = makeService([makeItem(ITEM_A)], { existing: [existing] });

    const result = await service.assignMany(OUTLET, [line(ITEM_A, '1300')], ACTOR);

    expect(assignments.updateAssignment).toHaveBeenCalledWith(expect.anything(), existing.id, {
      active: true,
      priceOverrideMinor: '1300',
      version: 7,
    });
    expect(assignments.insertAssignment).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      outcome: 'ASSIGNED',
      priceOverrideMinor: '1300',
      effectivePriceMinor: '1300',
    });
  });

  it('an explicit null clears a stored override back to the master default', async () => {
    const existing = makeAssignment(ITEM_A, { priceOverrideMinor: '1200', version: 2 });
    const { service, assignments, catalogChanges } = makeService([makeItem(ITEM_A)], { existing: [existing] });

    const result = await service.assignMany(OUTLET, [line(ITEM_A, null)], ACTOR);

    expect(assignments.updateAssignment).toHaveBeenCalledWith(expect.anything(), existing.id, {
      active: true,
      priceOverrideMinor: null,
      version: 3,
    });
    expect(catalogChanges.appendChanges.mock.calls[0][1][0]).toMatchObject({
      payload: { menuItemId: ITEM_A, unitPriceMinor: '1000' },
    });
    expect(result.items[0]).toMatchObject({ priceOverrideMinor: null, effectivePriceMinor: '1000' });
  });

  it('rejects a line price beyond the bigint range before any write', async () => {
    const { service, assignments, catalogChanges, audit } = makeService([makeItem(ITEM_A)]);

    await expect(service.assignMany(OUTLET, [line(ITEM_A, '9223372036854775808')], ACTOR)).rejects.toMatchObject({
      code: 'UNPROCESSABLE_ENTITY',
      details: { field: 'priceOverrideMinor' },
    });

    expect(assignments.insertAssignment).not.toHaveBeenCalled();
    expect(catalogChanges.appendChanges).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('single assign re-checks item status under the lock, not only on the pre-flight read', async () => {
    // The row was ACTIVE moments ago and got archived before the lock was taken.
    const live = makeItem(ITEM_A);
    const archived = makeItem(ITEM_A, { status: 'ARCHIVED' });
    const { service, menu, assignments, catalogChanges } = makeService([archived]);
    menu.findItem.mockResolvedValueOnce(live);

    await expect(
      service.assign(OUTLET, ITEM_A, { active: true, priceOverrideMinor: null }, ACTOR),
    ).rejects.toMatchObject({ code: 'ITEM_INACTIVE' });

    expect(assignments.insertAssignment).not.toHaveBeenCalled();
    expect(catalogChanges.appendChanges).not.toHaveBeenCalled();
  });

  it('single unassign of an unknown assignment still records the tombstone and its REMOVE revision', async () => {
    const { service, assignments, catalogChanges, audit } = makeService([makeItem(ITEM_A)]);

    const result = await service.unassign(OUTLET, ITEM_A, ACTOR);

    expect(assignments.insertAssignment).toHaveBeenCalledWith(expect.anything(), {
      outletId: OUTLET,
      menuItemId: ITEM_A,
      priceOverrideMinor: null,
      active: false,
    });
    expect(catalogChanges.appendChanges.mock.calls[0][1][0]).toMatchObject({ action: 'REMOVE' });
    expect(audit.record.mock.calls[0][0]).toMatchObject({ action: 'assignment.unassigned' });
    expect(result).toMatchObject({ outletId: OUTLET, menuItemId: ITEM_A, active: false, catalogRevision: '42' });
  });
});
