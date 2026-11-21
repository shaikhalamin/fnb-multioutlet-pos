import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

/** Immutable audit-trail listing filters (PRD §11 "audit views", FR-10). */
export class ListAuditLogsQuery {
  @ApiPropertyOptional({ type: Number, example: 50, default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from meta.nextCursor.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 'auth.login_failed', description: 'Exact action filter.' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  action?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ example: '2026-11-01T00:00:00Z', description: 'occurred_at lower bound (inclusive), ISO 8601 UTC.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-01T00:00:00Z', description: 'occurred_at upper bound (exclusive), ISO 8601 UTC.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class AuditLogResponse {
  @ApiProperty({ example: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11' })
  id!: string;

  @ApiProperty({ example: 'USER', enum: ['USER', 'OUTLET_KEY', 'SYSTEM'] })
  actorType!: string;

  @ApiProperty({ example: '3f7a4d60-1a08-4f0e-9e94-6c1e4f0e2a11', type: String, nullable: true })
  actorId!: string | null;

  @ApiProperty({ example: 'auth.login_failed' })
  action!: string;

  @ApiProperty({ example: 'api_key', type: String, nullable: true })
  entityType!: string | null;

  @ApiProperty({ example: '0b6a8fd0-0468-4f7a-9e94-6c1e4f0e2a11', type: String, nullable: true })
  entityId!: string | null;

  @ApiProperty({
    example: { reason: 'bad_credentials' },
    type: Object,
    description: 'Immutable structured context captured at write time.',
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ example: '2026-11-20T04:02:10.000Z' })
  occurredAt!: string;
}
