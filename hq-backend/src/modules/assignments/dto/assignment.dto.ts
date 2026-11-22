import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MONEY_MINOR_PATTERN } from '../../menu/dto/menu.dto.js';

/** Cap on one bulk assign — the master-items list page size. */
export const BULK_ASSIGN_MAX_ITEMS = 200;

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

/** One item line of a bulk assign: which item, and optionally its override. */
export class AssignMenuItemLine {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  @IsUUID()
  menuItemId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '1200',
    description:
      'Per-outlet price override in integer minor units (decimal string of bigint). ' +
      'Omitted keeps the stored override (or the master default), null clears it back to the default.',
    pattern: MONEY_MINOR_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY_MINOR_PATTERN, { message: 'priceOverrideMinor must be a nonnegative integer decimal string' })
  @MaxLength(19)
  priceOverrideMinor?: string | null;
}

/** `POST /outlets/:outletId/menu` — assign several items to one outlet in ONE transaction. */
export class AssignMenuItemsRequest {
  @ApiProperty({
    type: [AssignMenuItemLine],
    example: [
      { menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab', priceOverrideMinor: '1200' },
      { menuItemId: 'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4' },
    ],
    minItems: 1,
    maxItems: BULK_ASSIGN_MAX_ITEMS,
    description:
      `Master menu items to assign (activate) on this outlet — 1–${BULK_ASSIGN_MAX_ITEMS} lines with unique menuItemIds. ` +
      'Every item commits together, each with its own catalog revision; if any item is rejected, nothing commits.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ASSIGN_MAX_ITEMS)
  @ArrayUnique((line: AssignMenuItemLine) => line.menuItemId)
  @ValidateNested({ each: true })
  @Type(() => AssignMenuItemLine)
  items!: AssignMenuItemLine[];
}

/** One requested item's final state in an `AssignMenuItemsResponse`. */
export class AssignmentResultResponse {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: '31fe8f6b-02b8-409d-b1fa-6c441f422949' })
  assignmentId!: string;

  @ApiProperty({
    example: 'ASSIGNED',
    enum: ['ASSIGNED', 'UNCHANGED'],
    description:
      'ASSIGNED = created or reactivated (one UPSERT catalog revision emitted); ' +
      'UNCHANGED = already assigned in exactly this state, so no revision was consumed.',
  })
  outcome!: 'ASSIGNED' | 'UNCHANGED';

  @ApiProperty({ example: '1000', description: 'Master default price, minor units, decimal string of bigint.' })
  defaultPriceMinor!: string;

  @ApiProperty({
    example: '1200',
    type: String,
    nullable: true,
    description:
      'Override price, minor units, decimal string of bigint; null when the master default applies. ' +
      'An omitted request line keeps the stored override; a string sets it; null clears it.',
  })
  priceOverrideMinor!: string | null;

  @ApiProperty({ example: '1200', description: 'override ?? default, minor units, decimal string of bigint.' })
  effectivePriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;
}

export class AssignMenuItemsResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({
    example: '45',
    description:
      'Outlet catalog revision after the whole batch, decimal string of bigint; ' +
      'unchanged when every item was UNCHANGED.',
  })
  catalogRevision!: string;

  @ApiProperty({ example: 2, description: 'Items created or reactivated by this request.' })
  assignedCount!: number;

  @ApiProperty({ example: 1, description: 'Items that were already assigned and left untouched.' })
  unchangedCount!: number;

  @ApiProperty({ type: [AssignmentResultResponse], description: 'One row per requested item, in item-ID order.' })
  items!: AssignmentResultResponse[];
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
