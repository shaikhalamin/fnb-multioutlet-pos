import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { OutletUserStatus } from '../../../database/entities/outlet-user.entity.js';

const USER_STATUSES: readonly OutletUserStatus[] = ['ACTIVE', 'DISABLED'];

export class CreateUserRequest {
  @ApiProperty({ example: 'cashier@outlet-a.local', description: 'Work email; unique at this outlet.' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: ['OUTLET_CASHIER'], type: [String], description: 'Local role codes to assign.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roleCodes!: string[];
}

export class UpdateUserRequest {
  @ApiPropertyOptional({ example: 'DISABLED', enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES as unknown as string[])
  status?: OutletUserStatus;

  @ApiPropertyOptional({ example: ['OUTLET_CASHIER'], type: [String], description: 'Replaces the role set when present.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roleCodes?: string[];
}
