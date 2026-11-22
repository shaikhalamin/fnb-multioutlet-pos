import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, IsUrl, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SetupStatusResponse {
  @ApiProperty({ example: true, description: 'True once the outlet identity row exists (setup step 1 done).' })
  identity!: boolean;

  @ApiProperty({ example: false, description: 'True once the HQ connection row exists (setup step 2 done).' })
  hqConnection!: boolean;

  @ApiProperty({ example: false, description: 'True when both setup steps are complete; setup endpoints are sealed from then on.' })
  provisioned!: boolean;

  @ApiPropertyOptional({
    example: '11111111-1111-4111-8111-111111111111',
    type: String,
    nullable: true,
    description: 'HQ-issued outlet UUID, once provisioned.',
  })
  outletId!: string | null;

  @ApiPropertyOptional({
    example: 'A',
    type: String,
    nullable: true,
    description: 'Outlet code (receipt prefix), once provisioned.',
  })
  outletCode!: string | null;

  @ApiPropertyOptional({
    example: '2026-11-22T10:00:00.000Z',
    type: String,
    nullable: true,
    description: 'When HQ last accepted the stored key (ISO 8601 UTC).',
  })
  lastValidatedAt!: string | null;
}

export class CreateOutletIdentityRequest {
  @ApiProperty({
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Outlet UUID copied from the HQ console after outlet creation.',
  })
  @IsUUID()
  outletId!: string;

  @ApiProperty({ example: 'A', minLength: 1, maxLength: 8, description: 'Outlet code copied from the HQ console (receipt prefix).' })
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  outletCode!: string;

  @ApiProperty({ example: 'admin@outlet-a.local', description: 'First admin account email for this terminal.' })
  @IsEmail()
  adminEmail!: string;

  @ApiProperty({ example: 'Admin123!', minLength: 8, maxLength: 128, description: 'First admin account password.' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  adminPassword!: string;
}

export class SetupIdentityResponse {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  outletId!: string;

  @ApiProperty({ example: 'A' })
  outletCode!: string;

  @ApiProperty({ example: 'admin@outlet-a.local', description: 'The admin account created for this terminal.' })
  adminEmail!: string;
}

export class SaveHqConnectionRequest {
  @ApiProperty({
    example: 'http://hq-api:3000/api/v1',
    description: 'HQ sync API base URL reachable from this outlet (versioned /api/v1 root).',
  })
  @IsUrl({ require_protocol: true, require_tld: false })
  hqApiBaseUrl!: string;

  @ApiProperty({
    example: 'ok_dev_0123456789abcdef',
    minLength: 8,
    maxLength: 128,
    description: 'HQ-issued machine key ID (non-secret).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  keyId!: string;

  @ApiProperty({
    example: 'c2VjcmV0LXNoYXJlLW9mLWEtMjU2LWJpdC1rZXk',
    minLength: 16,
    maxLength: 256,
    description: 'One-time machine key secret shown by HQ at issuance. Transits only this request body.',
  })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  keySecret!: string;
}

export class HqConnectionResponse {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  outletId!: string;

  @ApiProperty({ example: 'http://hq-api:3000/api/v1' })
  hqApiBaseUrl!: string;

  @ApiProperty({ example: 'ok_dev_0123456789abcdef', description: 'The stored (non-secret) key ID.' })
  keyId!: string;

  @ApiProperty({ example: '2026-11-22T10:00:00.000Z', description: 'When HQ accepted this key during validation.' })
  lastValidatedAt!: string;

  @ApiProperty({ example: '0', description: 'HQ contiguous sequence watermark at validation — decimal string.' })
  highestContiguousSequence!: string;
}
