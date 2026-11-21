import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

/** Revenue-by-outlet filters (PRD §10): UTC window, optional currency. */
export class RevenueByOutletQuery {
  @ApiProperty({
    example: '2026-11-01T00:00:00Z',
    description: 'Window start (inclusive), ISO 8601 UTC instant.',
  })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({
    example: '2026-12-01T00:00:00Z',
    description: 'Window end (exclusive), ISO 8601 UTC instant.',
  })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 currency filter; defaults to the company currency. Unlike currencies are never summed.',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency?: string;
}

export class OutletRevenueResponse {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  outletId!: string;

  @ApiProperty({ example: 'Outlet A' })
  outletName!: string;

  @ApiProperty({
    example: '750000',
    description: 'Completed revenue in this window, integer minor units, decimal string of bigint.',
  })
  totalRevenueMinor!: string;

  @ApiProperty({ example: 450, description: 'Completed sales in this window.' })
  completedSaleCount!: number;

  @ApiProperty({
    example: '2026-11-20T04:02:10.000Z',
    type: String,
    nullable: true,
    description:
      'All-time last-ingested watermark (freshness signal independent of the window); null when the outlet never reported a sale.',
  })
  lastIngestedAt!: string | null;
}

export class RevenueByOutletResponse {
  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({
    type: [OutletRevenueResponse],
    description: 'Every ACTIVE outlet ordered by code — zero-sale outlets appear with "0", never omitted (§10).',
  })
  outlets!: OutletRevenueResponse[];

  @ApiProperty({
    example: '750000',
    description: 'Sum across outlets, integer minor units, decimal string of bigint.',
  })
  totalRevenueMinor!: string;

  @ApiProperty({
    example: '2026-11-20T04:02:10.000Z',
    type: String,
    nullable: true,
    description: 'Max ingested_at across all outlets; null when nothing has ever been ingested.',
  })
  dataAsOf!: string | null;

  @ApiProperty({
    example: true,
    description:
      'True when any ACTIVE outlet last reported a pending-outbox backlog or has never ingested a sale event — stale data must never read as zero sales (AT-20).',
  })
  isProvisional!: boolean;
}
