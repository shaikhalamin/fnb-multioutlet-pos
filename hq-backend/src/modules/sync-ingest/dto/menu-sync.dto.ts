import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Money/revision pattern: nonnegative canonical decimal string (PRD §7). */
const DECIMAL_STRING = /^(0|[1-9][0-9]{0,17})$/;

export class ListMenuChangesQuery {
  @ApiPropertyOptional({
    example: '41',
    description: 'Last revision the outlet applied; changes after it are returned. Decimal string.',
  })
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_STRING, { message: 'afterRevision must be a canonical decimal string' })
  afterRevision?: string;

  @ApiPropertyOptional({ example: 500, default: 500, maximum: 500 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Complete §8.3 POS-needed item snapshot carried by an UPSERT change. */
export class CatalogChangeItem {
  @ApiProperty({ example: '31fe8f6b-02b8-409d-b1fa-6c441f422949' })
  assignmentId!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'Grilled chicken burger' })
  description!: string;

  @ApiProperty({ example: 'Burgers' })
  category!: string;

  @ApiProperty({
    example: '1200',
    description: 'Effective outlet price — minor units, decimal string.',
  })
  unitPriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: true })
  active!: boolean;

  @ApiProperty({ example: 3, description: 'HQ item `version` at change-record time.' })
  itemVersion!: number;
}

export class CatalogChangeEntry {
  @ApiProperty({ example: '42', description: 'Per-outlet catalog revision — decimal string.' })
  revision!: string;

  @ApiProperty({ enum: ['UPSERT', 'REMOVE'] })
  type!: 'UPSERT' | 'REMOVE';

  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({
    type: CatalogChangeItem,
    nullable: true,
    description: 'Full effective item snapshot for UPSERT; null for REMOVE tombstones.',
  })
  item!: CatalogChangeItem | null;
}

export class CatalogChangesResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({ example: '41', description: 'The afterRevision this page starts from — decimal string.' })
  fromRevision!: string;

  @ApiProperty({
    example: '42',
    description: 'Revision after applying this page (checkpoint target) — decimal string.',
  })
  nextRevision!: string;

  @ApiProperty({ example: '42', description: "Outlet's current head revision — decimal string." })
  headRevision!: string;

  @ApiProperty({ example: false, description: 'True when more changes exist beyond this page.' })
  hasMore!: boolean;

  @ApiProperty({
    example: false,
    description: 'True when contiguous history is unavailable; the outlet must take a snapshot.',
  })
  snapshotRequired!: boolean;

  @ApiProperty({ type: [CatalogChangeEntry] })
  changes!: CatalogChangeEntry[];
}

export class MenuSnapshotItem {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  menuItemId!: string;

  @ApiProperty({ example: '31fe8f6b-02b8-409d-b1fa-6c441f422949' })
  assignmentId!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'Grilled chicken burger' })
  description!: string;

  @ApiProperty({ example: 'Burgers' })
  category!: string;

  @ApiProperty({ example: '1200', description: 'Effective outlet price — minor units, decimal string.' })
  unitPriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({
    example: true,
    description: 'False marks the tombstone: the outlet deactivates the item locally.',
  })
  active!: boolean;

  @ApiProperty({ example: 3 })
  itemVersion!: number;
}

export class MenuSnapshotResponse {
  @ApiProperty({ example: '6f1a2c34-1b2c-4d3e-9a7b-3c4d5e6f7a8b' })
  snapshotId!: string;

  @ApiProperty({ example: '42', description: 'Revision of the snapshot view — decimal string.' })
  snapshotRevision!: string;

  @ApiProperty({ type: [MenuSnapshotItem] })
  items!: MenuSnapshotItem[];
}
