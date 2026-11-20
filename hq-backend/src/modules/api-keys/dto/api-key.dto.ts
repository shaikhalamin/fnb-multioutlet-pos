import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { OUTLET_KEY_SCOPES } from '../../../common/utils/outlet-key.js';

const SCOPES = OUTLET_KEY_SCOPES as unknown as readonly string[];

export class IssueOutletKeyRequest {
  @ApiPropertyOptional({
    example: 72,
    description: 'Optional expiry in hours; omit for a non-expiring key.',
  })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(87_600) // ~10 years
  expiresInHours?: number;

  @ApiPropertyOptional({
    example: ['menu.pull', 'events.push', 'status.write'],
    type: [String],
    description: 'Scopes; defaults to all three sync scopes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(SCOPES, { each: true })
  scopes?: string[];
}

/** Issuance/rotation response — the raw secret appears exactly once. */
export class IssueOutletKeyResponse {
  @ApiProperty({ example: 'ok_dev_1a2b3c4d5e6f7788' })
  keyId!: string;

  @ApiProperty({
    example: 'wJalrXUtnFEMI_K7MDENG_bPxN3GYSlKP4UiZQyJ9q0',
    description: 'Raw 256-bit secret. Shown exactly once; store it securely now.',
  })
  secret!: string;

  @ApiProperty({ example: 'menu.pull', type: [String] })
  scopes!: string[];

  @ApiProperty({ example: '2026-11-21T04:00:00.000Z', type: String, nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', type: String, nullable: true })
  rotatedFromKeyId!: string | null;
}

/** Safe list row — never contains secret material. */
export class OutletApiKeyResponse {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' })
  id!: string;

  @ApiProperty({ example: 'ok_dev_1a2b3c4d5e6f7788' })
  keyId!: string;

  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({ example: ['menu.pull', 'events.push', 'status.write'], type: [String] })
  scopes!: string[];

  @ApiProperty({ example: 'ACTIVE', enum: ['ACTIVE', 'REVOKED'] })
  status!: string;

  @ApiProperty({ example: '2026-11-21T04:00:00.000Z', type: String, nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ example: '2026-11-20T04:02:10.000Z', type: String, nullable: true })
  lastUsedAt!: string | null;

  @ApiProperty({ example: 'ok_dev_9z8y7x6w5v4u3s2r', type: String, nullable: true })
  rotatedFromKeyId!: string | null;

  @ApiProperty({ example: '2026-11-20T04:00:00.000Z' })
  createdAt!: string;
}

export class RotateOutletKeyRequest {
  @ApiPropertyOptional({ example: 24, description: 'Overlap window for the predecessor key, hours.' })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(720)
  graceHours?: number;
}
