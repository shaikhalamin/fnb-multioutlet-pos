import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MONEY_MINOR_PATTERN } from '../../menu/dto/menu.dto.js';

export class AssignMenuRequest {
  @ApiProperty({ example: true, description: 'false soft-unassigns (tombstone).' })
  @IsBoolean()
  active!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '1200',
    description:
      'Per-outlet price override in integer minor units (decimal string of bigint). ' +
      'Send null to clear and fall back to the master default.',
    pattern: MONEY_MINOR_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY_MINOR_PATTERN, { message: 'priceOverrideMinor must be a nonnegative integer decimal string' })
  @MaxLength(19)
  priceOverrideMinor?: string | null;
}

export class AssignmentResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: '31fe8f6b-02b8-409d-b1fa-6c441f422949' })
  assignmentId!: string;

  @ApiProperty({ example: true })
  active!: boolean;

  @ApiProperty({ example: '1000', description: 'Master default price, minor units.' })
  defaultPriceMinor!: string;

  @ApiProperty({
    example: '1200',
    type: String,
    nullable: true,
    description: 'Override price, minor units; null when using the default.',
  })
  priceOverrideMinor!: string | null;

  @ApiProperty({ example: '1200', description: 'override ?? default, minor units.' })
  effectivePriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: '42', description: 'Catalog revision generated, decimal string of bigint.' })
  catalogRevision!: string;
}

/** Row of the HQ assignment matrix view (`GET /outlets/:id/menu`). */
export class OutletMenuResponse {
  @ApiProperty({ example: '31fe8f6b-02b8-409d-b1fa-6c441f422949' })
  assignmentId!: string;

  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'Burgers' })
  categoryName!: string;

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'ARCHIVED'] })
  itemStatus!: string;

  @ApiProperty({ example: true, description: 'Assignment active flag (effective only while item ACTIVE).' })
  active!: boolean;

  @ApiProperty({ example: '1000', description: 'Master default price, minor units.' })
  defaultPriceMinor!: string;

  @ApiProperty({ example: '1200', type: String, nullable: true })
  priceOverrideMinor!: string | null;

  @ApiProperty({ example: '1200' })
  effectivePriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;
}
