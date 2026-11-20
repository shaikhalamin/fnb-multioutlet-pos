import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { OutletStatus } from '../../../database/entities/outlet.entity.js';

const OUTLET_STATUSES: readonly OutletStatus[] = ['ACTIVE', 'SUSPENDED'];

export class CreateOutletRequest {
  @ApiProperty({ example: 'D', description: 'Short unique site code (1–8 chars).', minLength: 1, maxLength: 8 })
  @IsString()
  @Length(1, 8)
  code!: string;

  @ApiProperty({ example: 'Outlet D', maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ example: 'Asia/Dhaka', description: 'IANA time zone.' })
  @IsString()
  @Length(1, 64)
  timezone!: string;
}

export class UpdateOutletRequest {
  @ApiPropertyOptional({ example: 'Outlet D (Gulshan)' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: OUTLET_STATUSES })
  @IsOptional()
  @IsIn(OUTLET_STATUSES as unknown as string[])
  status?: OutletStatus;
}

export class OutletResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  id!: string;

  @ApiProperty({ example: 'A' })
  code!: string;

  @ApiProperty({ example: 'Outlet A' })
  name!: string;

  @ApiProperty({ example: 'UTC' })
  timezone!: string;

  @ApiProperty({ example: 'ACTIVE', enum: OUTLET_STATUSES })
  status!: string;

  @ApiProperty({ example: '42', description: 'Catalog revision, decimal string of bigint.' })
  catalogRevision!: string;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  createdAt!: string;
}
