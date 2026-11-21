import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { parseReportWindow } from './reporting.service.js';
import { ReportingService } from './reporting.service.js';
import type { ReportingRepository, TopItemRow } from './reporting.repository.js';
import type { OutletTopItemsQuery, RevenueByOutletQuery } from './dto/report.dto.js';

const OUTLET_A = '11111111-1111-4111-8111-111111111111';
const OUTLET_B = '22222222-2222-4222-8222-222222222222';

const INGESTED_A = new Date('2026-11-20T04:02:10.000Z');
const INGESTED_B = new Date('2026-11-19T09:15:00.000Z');

function makeService(
  overrides: {
    outlets?: Array<{ outletId: string; outletName: string }>;
    windowTotals?: Map<string, { totalRevenueMinor: string; completedSaleCount: number }>;
    watermarks?: Map<string, Date>;
    pendingBacklogs?: Map<string, number>;
    companyCurrency?: string | null;
  } = {},
) {
  const outlets = overrides.outlets ?? [
    { outletId: OUTLET_A, outletName: 'Outlet A' },
    { outletId: OUTLET_B, outletName: 'Outlet B' },
  ];
  const windowTotals =
    overrides.windowTotals ??
    new Map([[OUTLET_A, { totalRevenueMinor: '2400', completedSaleCount: 2 }]]);
  const watermarks = overrides.watermarks ?? new Map([[OUTLET_A, INGESTED_A]]);
  const pendingBacklogs = overrides.pendingBacklogs ?? new Map<string, number>();
  const reporting = {
    findCompanyCurrency: vi.fn().mockResolvedValue(
      overrides.companyCurrency === undefined ? 'USD' : overrides.companyCurrency,
    ),
    listActiveOutlets: vi.fn().mockResolvedValue(outlets),
    sumWindowRevenue: vi.fn().mockResolvedValue(windowTotals),
    listIngestWatermarks: vi.fn().mockResolvedValue({
      byOutlet: watermarks,
      dataAsOf: [...watermarks.values()].reduce<Date | null>(
        (max, at) => (!max || at > max ? at : max),
        null,
      ),
    }),
    listActivePendingBacklogs: vi.fn().mockResolvedValue(pendingBacklogs),
  };
  const dataSource = { getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue({ id: 'c1' }) }) };
  const service = new ReportingService(
    dataSource as unknown as DataSource,
    reporting as unknown as ReportingRepository,
  );
  return { service, reporting, sumWindowRevenue: reporting.sumWindowRevenue };
}

const query = (patch: Partial<RevenueByOutletQuery> = {}): RevenueByOutletQuery => ({
  from: '2026-11-01T00:00:00Z',
  to: '2026-12-01T00:00:00Z',
  ...patch,
});

describe('parseReportWindow', () => {
  // parseReportWindow throws synchronously, so rejections are asserted by
  // catching rather than through `rejects`.
  function expectWindowRejected(from: string, to: string): void {
    let caught: unknown;
    try {
      parseReportWindow(from, to);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  }

  it('accepts a well-formed UTC window', () => {
    const window = parseReportWindow('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z');
    expect(window.from.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('rejects from >= to', () => {
    expectWindowRejected('2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z');
    expectWindowRejected('2026-11-03T00:00:00Z', '2026-11-02T00:00:00Z');
  });

  it('rejects a window longer than 366 days (§15 bound)', () => {
    expectWindowRejected('2025-01-01T00:00:00Z', '2026-12-01T00:00:00Z');
  });
});

describe('ReportingService.revenueByOutlet', () => {
  it('sums per-outlet revenue exactly as decimal strings, including > 2^53 fixtures', async () => {
    // 2^53 + 1 and 2 — JS float math would corrupt this sum.
    const { service } = makeService({
      windowTotals: new Map([
        [OUTLET_A, { totalRevenueMinor: '9007199254740993', completedSaleCount: 1 }],
        [OUTLET_B, { totalRevenueMinor: '2', completedSaleCount: 1 }],
      ]),
      watermarks: new Map([
        [OUTLET_A, INGESTED_A],
        [OUTLET_B, INGESTED_B],
      ]),
    });
    const report = await service.revenueByOutlet(query());
    expect(report.totalRevenueMinor).toBe('9007199254740995');
    expect(report.outlets.map((o) => o.totalRevenueMinor)).toEqual(['9007199254740993', '2']);
  });

  it('includes every ACTIVE outlet with zero sales and null watermark when never ingested', async () => {
    const { service } = makeService(); // B has no window rows and no watermark
    const report = await service.revenueByOutlet(query());
    const outletB = report.outlets.find((o) => o.outletId === OUTLET_B)!;
    expect(outletB).toMatchObject({ totalRevenueMinor: '0', completedSaleCount: 0, lastIngestedAt: null });
    expect(report.dataAsOf).toBe(INGESTED_A.toISOString());
  });

  it('passes the window through as from-inclusive / to-exclusive bounds', async () => {
    const { service, sumWindowRevenue } = makeService();
    await service.revenueByOutlet(query());
    expect(sumWindowRevenue).toHaveBeenCalledWith({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      currencyCode: 'USD',
    });
  });

  it('defaults the currency to the company currency and honors an explicit filter', async () => {
    const { service, reporting } = makeService({ companyCurrency: 'EUR' });
    await service.revenueByOutlet(query());
    expect(reporting.findCompanyCurrency).toHaveBeenCalledTimes(1);
    const explicit = await service.revenueByOutlet(query({ currency: 'BDT' }));
    expect(explicit.currencyCode).toBe('BDT');
    // The explicit filter replaces, never mixes, the company currency.
    expect(reporting.sumWindowRevenue).toHaveBeenLastCalledWith(
      expect.objectContaining({ currencyCode: 'BDT' }),
    );
  });

  it('refuses to invent a currency when the company row has none (no silent default)', async () => {
    const { service } = makeService({ companyCurrency: null });
    let caught: unknown;
    try {
      await service.revenueByOutlet(query());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
  });

  it('isProvisional truth table: backlog, never-ingested, and clean cases', async () => {
    // Heartbeat backlog > 0 on any ACTIVE outlet → provisional.
    const backlog = makeService({ pendingBacklogs: new Map([[OUTLET_A, 7]]) });
    expect((await backlog.service.revenueByOutlet(query())).isProvisional).toBe(true);

    // Never-ingested outlet → provisional (missing ≠ zero).
    const neverIngested = makeService();
    expect((await neverIngested.service.revenueByOutlet(query())).isProvisional).toBe(true);

    // All outlets ingested, no backlog → final.
    const clean = makeService({
      watermarks: new Map([
        [OUTLET_A, INGESTED_A],
        [OUTLET_B, INGESTED_B],
      ]),
    });
    expect((await clean.service.revenueByOutlet(query())).isProvisional).toBe(false);

    // A zero backlog heartbeat is NOT provisional by itself.
    const drained = makeService({
      watermarks: new Map([
        [OUTLET_A, INGESTED_A],
        [OUTLET_B, INGESTED_B],
      ]),
      pendingBacklogs: new Map([
        [OUTLET_A, 0],
        [OUTLET_B, 0],
      ]),
    });
    expect((await drained.service.revenueByOutlet(query())).isProvisional).toBe(false);
  });

  it('dataAsOf is the max watermark across outlets, null when nothing ingested', async () => {
    const { service } = makeService({
      watermarks: new Map([[OUTLET_B, INGESTED_B]]),
    });
    // Sole watermark (Nov 19) — earlier than A's would-be watermark, still max.
    expect((await service.revenueByOutlet(query())).dataAsOf).toBe(INGESTED_B.toISOString());

    const empty = makeService({ watermarks: new Map(), windowTotals: new Map() });
    const report = await empty.service.revenueByOutlet(query());
    expect(report.dataAsOf).toBeNull();
    expect(report.totalRevenueMinor).toBe('0');
  });
});

const topItem = (menuItemId: string, quantitySold: number, patch: Partial<TopItemRow> = {}): TopItemRow => ({
  menuItemId,
  currentName: `Master ${menuItemId}`,
  snapshotName: `Snapshot ${menuItemId}`,
  quantitySold,
  ...patch,
});

function makeTopItemsService(rows: TopItemRow[], outletExists = true) {
  const reporting = {
    findCompanyCurrency: vi.fn().mockResolvedValue('USD'),
    listActiveOutlets: vi.fn().mockResolvedValue([]),
    sumWindowRevenue: vi.fn().mockResolvedValue(new Map()),
    listIngestWatermarks: vi.fn().mockResolvedValue({ byOutlet: new Map([[OUTLET_A, INGESTED_A]]), dataAsOf: INGESTED_A }),
    listActivePendingBacklogs: vi.fn().mockResolvedValue(new Map<string, number>()),
    findOutlet: vi.fn().mockResolvedValue(outletExists),
    topItemsByOutlet: vi.fn().mockResolvedValue(rows),
  };
  const dataSource = { getRepository: vi.fn().mockReturnValue({ findOne: vi.fn().mockResolvedValue({ id: 'c1' }) }) };
  const service = new ReportingService(
    dataSource as unknown as DataSource,
    reporting as unknown as ReportingRepository,
  );
  return { service, reporting };
}

const topQuery = (patch: Partial<OutletTopItemsQuery> = {}): OutletTopItemsQuery => ({
  from: '2026-11-01T00:00:00Z',
  to: '2026-12-01T00:00:00Z',
  ...patch,
});

describe('ReportingService.topItemsForOutlet', () => {
  it('orders by quantitySold DESC with menu_item_id as deterministic tie-break', async () => {
    // Deliberately unsorted fixture: equal quantities must fall back to id,
    // and the smaller quantity must rank last regardless of input order.
    const rows = [
      topItem('c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4', 200),
      topItem('9708835e-2e21-465a-87e9-5f8d56cd44ab', 250),
      topItem('3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110', 250),
    ];
    const { service } = makeTopItemsService(rows);
    const report = await service.topItemsForOutlet(OUTLET_A, topQuery());
    expect(report.items.map((item) => item.menuItemId)).toEqual([
      '3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110',
      '9708835e-2e21-465a-87e9-5f8d56cd44ab',
      'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4',
    ]);
    expect(report.items.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it('falls back to the sale-time snapshot name for ARCHIVED or missing master items', async () => {
    // The SQL join resolves names only from ACTIVE master rows, so both an
    // ARCHIVED item (tombstoned, row still present) and an id absent from the
    // master catalog surface here with currentName: null.
    const rows = [
      topItem('9708835e-2e21-465a-87e9-5f8d56cd44ab', 10, { currentName: null }),
      topItem('c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4', 5),
    ];
    const { service } = makeTopItemsService(rows);
    const report = await service.topItemsForOutlet(OUTLET_A, topQuery());
    expect(report.items[0]?.itemName).toBe('Snapshot 9708835e-2e21-465a-87e9-5f8d56cd44ab');
    expect(report.items[1]?.itemName).toBe('Master c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4');
  });

  it('passes from/to through as window bounds and defaults limit to 5', async () => {
    const { service, reporting } = makeTopItemsService([]);
    await service.topItemsForOutlet(OUTLET_A, topQuery());
    expect(reporting.topItemsByOutlet).toHaveBeenCalledWith({
      outletId: OUTLET_A,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      limit: 5,
    });
    await service.topItemsForOutlet(OUTLET_A, topQuery({ limit: 2 }));
    expect(reporting.topItemsByOutlet).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it('caps the ranked rows at the requested limit', async () => {
    const rows = [
      topItem('3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110', 30),
      topItem('9708835e-2e21-465a-87e9-5f8d56cd44ab', 20),
      topItem('c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4', 10),
    ];
    const { service } = makeTopItemsService(rows);
    const report = await service.topItemsForOutlet(OUTLET_A, topQuery({ limit: 2 }));
    expect(report.items).toHaveLength(2);
    expect(report.items.at(-1)?.quantitySold).toBe(20);
  });

  it('scopes strictly to the requested outlet and 404s unknown outlets', async () => {
    const rows = [topItem('9708835e-2e21-465a-87e9-5f8d56cd44ab', 7)];
    const { service, reporting } = makeTopItemsService(rows);
    const report = await service.topItemsForOutlet(OUTLET_A, topQuery());
    // Outlet isolation: the repository filter — not post-filtering — carries
    // the scope; the report echoes exactly that outlet.
    expect(reporting.topItemsByOutlet).toHaveBeenCalledWith(expect.objectContaining({ outletId: OUTLET_A }));
    expect(report.outletId).toBe(OUTLET_A);
    expect(report.items.every((item) => item.menuItemId === '9708835e-2e21-465a-87e9-5f8d56cd44ab')).toBe(true);

    const missing = makeTopItemsService(rows, false);
    await expect(missing.service.topItemsForOutlet(OUTLET_B, topQuery())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});
