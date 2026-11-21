import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { resolveCompanyId } from '../../common/utils/company.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import type { OutletRevenueResponse, RevenueByOutletQuery, RevenueByOutletResponse } from './dto/report.dto.js';
import { ReportingRepository } from './reporting.repository.js';

/** §15 unbounded-query protection: report windows are capped at 366 days. */
export const MAX_REPORT_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Parses and enforces the UTC report-window contract (PRD §10): `from`
 * inclusive, `to` exclusive, `from < to`, span bounded (§15).
 */
export function parseReportWindow(from: string, to: string): { from: Date; to: Date } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ApiException('VALIDATION_FAILED', 'from/to must be ISO 8601 timestamps.', 400, { from, to });
  }
  if (fromDate.getTime() >= toDate.getTime()) {
    throw new ApiException('VALIDATION_FAILED', 'from must be strictly before to.', 400, { from, to });
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_REPORT_WINDOW_MS) {
    throw new ApiException('VALIDATION_FAILED', 'The report window must not exceed 366 days.', 400, {
      from,
      to,
    });
  }
  return { from: fromDate, to: toDate };
}

/**
 * Cross-outlet reporting (PRD §10, FR-08): computed on request from the HQ
 * projections — no caching layer, no outlet-database access. Staleness is
 * always disclosed: `dataAsOf` + per-outlet watermarks + `isProvisional`
 * (AT-20), and every ACTIVE outlet appears even with zero in-window sales so
 * a missing contribution never reads as "no sales".
 */
@Injectable()
export class ReportingService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly reporting: ReportingRepository,
  ) {}

  async revenueByOutlet(query: RevenueByOutletQuery): Promise<RevenueByOutletResponse> {
    const window = parseReportWindow(query.from, query.to);
    const companyId = await resolveCompanyId(this.dataSource);
    const currencyCode = query.currency ?? (await this.reporting.findCompanyCurrency(companyId));

    const [outlets, windowTotals, watermarks, pendingBacklogs] = await Promise.all([
      this.reporting.listActiveOutlets(companyId),
      this.reporting.sumWindowRevenue({ ...window, currencyCode }),
      this.reporting.listIngestWatermarks(),
      this.reporting.listActivePendingBacklogs(),
    ]);

    let totalRevenueMinor = 0n;
    let isProvisional = false;
    const rows: OutletRevenueResponse[] = outlets.map((outlet) => {
      const inWindow = windowTotals.get(outlet.outletId);
      const totalMinor = inWindow?.totalRevenueMinor ?? '0';
      totalRevenueMinor += BigInt(totalMinor);
      const lastIngestedAt = watermarks.byOutlet.get(outlet.outletId) ?? null;
      const pending = pendingBacklogs.get(outlet.outletId) ?? 0;
      if (!lastIngestedAt || pending > 0) isProvisional = true;
      return {
        outletId: outlet.outletId,
        outletName: outlet.outletName,
        totalRevenueMinor: totalMinor,
        completedSaleCount: inWindow?.completedSaleCount ?? 0,
        lastIngestedAt: lastIngestedAt ? lastIngestedAt.toISOString() : null,
      };
    });

    return {
      currencyCode,
      outlets: rows,
      totalRevenueMinor: totalRevenueMinor.toString(),
      dataAsOf: watermarks.dataAsOf ? watermarks.dataAsOf.toISOString() : null,
      isProvisional,
    };
  }
}
