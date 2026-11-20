import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const MONEY_MINOR_PATTERN = /^(0|[1-9][0-9]*)$/;

export class CreateCategoryRequest {
  @ApiProperty({ example: 'Desserts', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 3, default: 0 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(1_000)
  sortOrder?: number;
}

export class UpdateCategoryRequest {
  @ApiPropertyOptional({ example: 'Sweets', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(1_000)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class CategoryResponse {
  @ApiProperty({ example: 'd0edcfef-715c-4a3d-a1dc-fcfec4ea8045' })
  id!: string;

  @ApiProperty({ example: 'Burgers' })
  name!: string;

  @ApiProperty({ example: 0 })
  sortOrder!: number;

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  updatedAt!: string;
}

export class CreateMenuItemRequest {
  @ApiProperty({ example: 'BURGER-02', maxLength: 64, description: 'Immutable; unique per company.' })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: 'Beef Burger', maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ example: 'Flame-grilled beef burger', maxLength: 1_000 })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @ApiProperty({ example: 'd0edcfef-715c-4a3d-a1dc-fcfec4ea8045' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({
    example: '1000',
    description: 'Default price in integer minor units, decimal string of bigint.',
    pattern: MONEY_MINOR_PATTERN.source,
  })
  @IsString()
  @Matches(MONEY_MINOR_PATTERN, { message: 'defaultPriceMinor must be a nonnegative integer decimal string' })
  @MaxLength(19)
  defaultPriceMinor!: string;

  @ApiProperty({ example: 'USD', description: 'Must match the company currency.' })
  @IsString()
  @Length(3, 3)
  currencyCode!: string;
}

export class UpdateMenuItemRequest {
  @ApiPropertyOptional({ example: 'Chicken Burger Deluxe' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ example: 'Now with spicy mayo' })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @ApiPropertyOptional({ example: 'd0edcfef-715c-4a3d-a1dc-fcfec4ea8045' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    example: '1200',
    description: 'Integer minor units, decimal string of bigint.',
    pattern: MONEY_MINOR_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY_MINOR_PATTERN, { message: 'defaultPriceMinor must be a nonnegative integer decimal string' })
  @MaxLength(19)
  defaultPriceMinor?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'], description: 'ARCHIVED tombstones the item.' })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class MenuItemResponse {
  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  id!: string;

  @ApiProperty({ example: 'BURGER-01' })
  sku!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  name!: string;

  @ApiProperty({ example: 'Grilled chicken burger' })
  description!: string;

  @ApiProperty({ example: 'd0edcfef-715c-4a3d-a1dc-fcfec4ea8045' })
  categoryId!: string;

  @ApiProperty({ example: 'Burgers' })
  categoryName!: string;

  @ApiProperty({ example: '1000', description: 'Integer minor units, decimal string of bigint.' })
  defaultPriceMinor!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ example: 3, description: 'Bumped on every edit; echoed to outlets.' })
  version!: number;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  updatedAt!: string;
}

export class ListMenuItemsQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ example: 'burger', description: 'Substring match on name or SKU.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  q?: string;

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
