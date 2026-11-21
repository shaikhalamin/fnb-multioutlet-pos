import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsUUID, Max, Min, NotEquals } from 'class-validator';

export const STOCK_ADJUSTMENT_REASONS = ['RESTOCK', 'WRITE_OFF', 'RECOUNT'] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

export class AdjustInventoryRequest {
  @ApiProperty({
    example: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
    description: 'Local catalog item to adjust.',
  })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({
    example: 50,
    description: 'Signed, nonzero quantity delta applied to on-hand stock (±1,000,000).',
  })
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  @NotEquals(0, { message: 'deltaQuantity must be nonzero.' })
  deltaQuantity!: number;

  @ApiProperty({ example: 'RESTOCK', enum: STOCK_ADJUSTMENT_REASONS })
  @IsIn(STOCK_ADJUSTMENT_REASONS as unknown as string[])
  reason!: StockAdjustmentReason;
}

export class InventoryBalanceResponse {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 30, description: 'On-hand quantity (integer).' })
  quantityOnHand!: number;

  @ApiProperty({ example: 4, description: 'Balance row version; bumps on every mutation.' })
  version!: number;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  updatedAt!: string;
}

export class AdjustInventoryResponse {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: 80, description: 'On-hand quantity after the adjustment.' })
  quantityOnHand!: number;

  @ApiProperty({ example: 5 })
  version!: number;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  updatedAt!: string;
}
