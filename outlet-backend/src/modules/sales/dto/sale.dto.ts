import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateSaleRequestLine {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab', description: 'Local catalog item UUID.' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 100000, description: 'Line quantity; duplicates are merged by menuItemId server-side.' })
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;
}

/**
 * `POST /sales` body (PRD §7.3): lines carry ONLY `menuItemId` + `quantity`.
 * Price, total, receipt, soldAt and outlet identity are always
 * server-computed — any other field is rejected by the global whitelist
 * pipe by construction (root AGENTS §5).
 */
export class CreateSaleRequest {
  @ApiProperty({
    type: [CreateSaleRequestLine],
    description: '1..100 distinct lines; duplicate menuItemIds are merged before validation.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: CreateSaleRequestLine[];
}

export class SaleItemResponse {
  @ApiProperty({ example: '64750166-32a4-46f8-9285-f536f5b03213' })
  saleItemId!: string;

  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: 'Chicken Burger', description: 'Immutable name snapshot captured at sale time (FR-02).' })
  name!: string;

  @ApiProperty({ example: 'BURGER-01', description: 'Immutable SKU snapshot captured at sale time.' })
  sku!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: '1200', description: 'Snapshot unit price, integer minor units, decimal string.' })
  unitPriceMinor!: string;

  @ApiProperty({ example: '2400', description: 'Line subtotal, integer minor units, decimal string.' })
  subtotalMinor!: string;
}

export class SaleResponse {
  @ApiProperty({ example: '0a44e56a-628e-492a-81e0-83f4a4d68f76' })
  id!: string;

  @ApiProperty({ example: 'A-000001', description: 'Outlet-scoped display receipt.' })
  receiptNo!: string;

  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  outletId!: string;

  @ApiProperty({ example: 'COMPLETED', enum: ['COMPLETED'] })
  status!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ type: [SaleItemResponse] })
  items!: SaleItemResponse[];

  @ApiProperty({ example: '3900', description: 'Total, integer minor units, decimal string.' })
  totalMinor!: string;

  @ApiProperty({ example: '1', description: 'Local catalog revision the sale was priced against, decimal string.' })
  catalogRevision!: string;

  @ApiProperty({ example: '2026-11-20T04:02:03.000Z' })
  soldAt!: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'RETRY', 'DELIVERED', 'QUARANTINED'],
    description: 'Resolved from the outbox row; separate from sale status (PRD §8.7).',
  })
  syncStatus!: string;
}

export class SaleSummaryResponse {
  @ApiProperty({ example: '0a44e56a-628e-492a-81e0-83f4a4d68f76' })
  id!: string;

  @ApiProperty({ example: 'A-000001' })
  receiptNo!: string;

  @ApiProperty({ example: '3900', description: 'Total, integer minor units, decimal string.' })
  totalMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: 'COMPLETED', enum: ['COMPLETED'] })
  status!: string;

  @ApiProperty({ example: '2026-11-20T04:02:03.000Z' })
  soldAt!: string;

  @ApiProperty({ example: 3, description: 'Number of merged sale lines.' })
  lineCount!: number;
}

export class ListSalesQuery {
  @ApiPropertyOptional({ example: '2026-11-01T00:00:00.000Z', description: 'Inclusive lower bound on soldAt (ISO 8601 UTC).' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30T23:59:59.999Z', description: 'Inclusive upper bound on soldAt (ISO 8601 UTC).' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ example: 50, default: 50, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from meta.nextCursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

/** Header DTO surfaced by Swagger for the idempotent sale route. */
export class IdempotencyKeyHeader {
  @ApiProperty({
    example: 'pos-register-2-4af2e801-6351-4bd5-abf6-536c02b918c4',
    description: 'Client-minted key, stable across retries of the same sale attempt.',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  'Idempotency-Key'!: string;
}
