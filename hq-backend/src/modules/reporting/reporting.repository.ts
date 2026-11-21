import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { CompanyEntity } from '../../database/entities/company.entity.js';

export type ActiveOutletRow = { outletId: string; outletName: string };
export type WindowRevenueRow = { outletId: string; totalRevenueMinor: string; completedSaleCount: number };
export type TopItemRow = {
  menuItemId: string;
  currentName: string | null;
  snapshotName: string;
  quantitySold: number;
};

/**
 * Read-only reporting queries (PRD §10, FR-08): aggregation runs entirely in
 * SQL over the HQ projections (`hq_sales`/`hq_sale_items`) — outlet databases
 * are never queried and money sums never pass through a JS number.
 */
@Injectable()
export class ReportingRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async findCompanyCurrency(companyId: string): Promise<string> {
    const company = await this.dataSource
      .getRepository(CompanyEntity)
      .findOne({ where: { id: companyId } });
    return company?.currencyCode ?? 'USD';
  }

  /** Every ACTIVE outlet of the company, ordered by code (report row order). */
  async listActiveOutlets(companyId: string): Promise<ActiveOutletRow[]> {
    const rows = await this.dataSource.query<Array<{ outlet_id: string; name: string }>>(
      `SELECT id::text AS outlet_id, name
       FROM outlets
       WHERE company_id = $1 AND status = 'ACTIVE'
       ORDER BY code ASC`,
      [companyId],
    );
    return rows.map((row) => ({ outletId: row.outlet_id, outletName: row.name }));
  }

  /** Completed revenue per outlet for the window (`from` inclusive, `to` exclusive). */
  async sumWindowRevenue(filter: {
    from: Date;
    to: Date;
    currencyCode: string;
  }): Promise<Map<string, WindowRevenueRow>> {
    const rows = await this.dataSource.query<
      Array<{ outlet_id: string; total_minor: string; sale_count: number }>
    >(
      `SELECT outlet_id::text AS outlet_id, SUM(total_minor)::text AS total_minor, COUNT(*)::int AS sale_count
       FROM hq_sales
       WHERE status = 'COMPLETED' AND sold_at >= $1 AND sold_at < $2 AND currency_code = $3
       GROUP BY outlet_id`,
      [filter.from.toISOString(), filter.to.toISOString(), filter.currencyCode],
    );
    return new Map(
      rows.map((row) => [
        row.outlet_id,
        { outletId: row.outlet_id, totalRevenueMinor: row.total_minor, completedSaleCount: row.sale_count },
      ]),
    );
  }

  /**
   * All-time per-outlet `MAX(ingested_at)` watermarks (freshness is
   * independent of the query window) plus the report-level `dataAsOf` — one
   * scan over the reporting index columns.
   */
  async listIngestWatermarks(): Promise<{
    byOutlet: Map<string, Date>;
    dataAsOf: Date | null;
  }> {
    const rows = await this.dataSource.query<
      Array<{ outlet_id: string; last_ingested_at: Date | null }>
    >(
      `SELECT outlet_id::text AS outlet_id, MAX(ingested_at) AS last_ingested_at
       FROM hq_sales
       GROUP BY outlet_id`,
    );
    const byOutlet = new Map<string, Date>();
    let dataAsOf: Date | null = null;
    for (const row of rows) {
      if (!row.last_ingested_at) continue;
      const at = new Date(row.last_ingested_at);
      byOutlet.set(row.outlet_id, at);
      if (!dataAsOf || at > dataAsOf) dataAsOf = at;
    }
    return { byOutlet, dataAsOf };
  }

  /**
   * Last heartbeat `pendingOutboxCount` per ACTIVE outlet — feeds the
   * `isProvisional` staleness flag (AT-20). Outlets without a checkpoint row
   * or heartbeat payload are simply absent.
   */
  async listActivePendingBacklogs(): Promise<Map<string, number>> {
    const rows = await this.dataSource.query<Array<{ outlet_id: string; pending: number | null }>>(
      `SELECT c.outlet_id::text AS outlet_id, (c.last_reported_backlog->>'pendingOutboxCount')::int AS pending
       FROM sync_outlet_checkpoints c
       JOIN outlets o ON o.id = c.outlet_id
       WHERE o.status = 'ACTIVE'`,
    );
    const pending = new Map<string, number>();
    for (const row of rows) {
      if (row.pending !== null) pending.set(row.outlet_id, row.pending);
    }
    return pending;
  }

  async findOutlet(companyId: string, outletId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ exists: boolean }>>(
      'SELECT EXISTS (SELECT 1 FROM outlets WHERE company_id = $1 AND id = $2) AS exists',
      [companyId, outletId],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Per-outlet top items (PRD §10): groups `hq_sale_items` by stable
   * `menu_item_id`, sums quantity, and orders `quantitySold DESC,
   * menu_item_id` (deterministic tie-break). The master-name join is a LEFT
   * JOIN — the caller falls back to the immutable `name_snapshot` when the
   * item is no longer in the master catalog.
   */
  async topItemsByOutlet(filter: {
    outletId: string;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<TopItemRow[]> {
    const rows = await this.dataSource.query<
      Array<{
        menu_item_id: string;
        current_name: string | null;
        snapshot_name: string;
        quantity_sold: number;
      }>
    >(
      `SELECT i.menu_item_id::text AS menu_item_id,
              MAX(m.name) AS current_name,
              MAX(i.name_snapshot) AS snapshot_name,
              SUM(i.quantity)::int AS quantity_sold
       FROM hq_sale_items i
       JOIN hq_sales s ON s.id = i.hq_sale_id
       LEFT JOIN master_menu_items m ON m.id = i.menu_item_id
       WHERE s.outlet_id = $1
         AND s.status = 'COMPLETED'
         AND s.sold_at >= $2
         AND s.sold_at < $3
       GROUP BY i.menu_item_id
       ORDER BY quantity_sold DESC, i.menu_item_id ASC
       LIMIT $4`,
      [filter.outletId, filter.from.toISOString(), filter.to.toISOString(), filter.limit],
    );
    return rows.map((row) => ({
      menuItemId: row.menu_item_id,
      currentName: row.current_name,
      snapshotName: row.snapshot_name,
      quantitySold: row.quantity_sold,
    }));
  }
}
