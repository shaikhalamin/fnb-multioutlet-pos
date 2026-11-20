import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { HqUserStatus } from '../../../database/entities/hq-user.entity.js';

const USER_STATUSES: readonly HqUserStatus[] = ['ACTIVE', 'DISABLED'];

export class CreateUserRequest {
  @ApiProperty({ example: 'manager@fnb.local', description: 'Work email; unique per company.' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass123!', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: ['HQ_MENU_MANAGER'], type: [String], description: 'Role codes to assign.' })
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
  status?: HqUserStatus;

  @ApiPropertyOptional({ example: ['HQ_ANALYST'], type: [String], description: 'Replaces the role set when present.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  roleCodes?: string[];
}
