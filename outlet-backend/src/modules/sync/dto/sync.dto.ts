import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class SyncGraceOverrideStatus {
  @ApiProperty({ example: true, description: 'True while the override still extends the grace window.' })
  active!: boolean;

  @ApiProperty({ example: '2026-11-23T12:00:00.000Z' })
  until!: string;

  @ApiProperty({ example: 'Regional network outage — connector replacement scheduled.', maxLength: 500 })
  reason!: string;

  @ApiProperty({ example: '33333333-3333-4333-8333-333333333333', description: 'The manager who applied the override.' })
  overriddenBy!: string;
}

export class SyncGraceStatus {
  @ApiProperty({ example: 72, description: 'Configured offline grace window in hours (PRD §8.8).' })
  hours!: number;

  @ApiProperty({
    example: '2026-11-23T04:00:00.000Z',
    type: String,
    nullable: true,
    description: 'Effective grace expiry (window or active override); null when never synced.',
  })
  expiresAt!: string | null;

  @ApiProperty({ example: false, description: 'True once the effective grace expiry has lapsed; new sales are blocked.' })
  expired!: boolean;

  @ApiPropertyOptional({
    type: SyncGraceOverrideStatus,
    nullable: true,
    description: 'The active emergency override, when one is in force (PRD §8.8).',
  })
  override!: SyncGraceOverrideStatus | null;
}

export class SyncOutboxErrorSample {
  @ApiProperty({ example: '3feeb5c0-53fa-476e-a758-3040a3529041', description: 'The quarantined event ID.' })
  eventId!: string;

  @ApiProperty({ example: '108', description: 'Per-outlet sequence — decimal string.' })
  sequenceNo!: string;

  @ApiProperty({
    example: 'EVENT_ID_CONFLICT',
    type: String,
    nullable: true,
    description: 'The terminal error that parked the event.',
  })
  lastError!: string | null;
}

export class SyncOutboxStatus {
  @ApiProperty({ example: 1, description: 'Events awaiting delivery (PENDING).' })
  pendingCount!: number;

  @ApiProperty({ example: 0, description: 'Events parked for manual repair (QUARANTINED).' })
  quarantinedCount!: number;

  @ApiProperty({
    example: '2026-11-20T04:02:03.000Z',
    type: String,
    nullable: true,
    description: 'Oldest undelivered event timestamp; null when the outbox is drained.',
  })
  oldestPendingAt!: string | null;

  @ApiProperty({
    example: '2026-11-20T04:02:10.000Z',
    type: String,
    nullable: true,
    description: 'Most recent successful delivery; null when nothing has been delivered yet.',
  })
  lastPublishedAt!: string | null;

  @ApiPropertyOptional({
    type: [SyncOutboxErrorSample],
    nullable: true,
    description: 'Quarantined events with their terminal errors, for operator review.',
  })
  lastErrorSample!: SyncOutboxErrorSample[] | null;
}

export class SyncStatusResponse {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  outletId!: string;

  @ApiProperty({ example: 'A' })
  outletCode!: string;

  @ApiProperty({ example: '1', description: 'Last applied HQ catalog revision, decimal string.' })
  lastAppliedRevision!: string;

  @ApiProperty({
    example: '2026-11-20T04:00:00.000Z',
    type: String,
    nullable: true,
    description: 'Last successful menu sync; null when never synced.',
  })
  lastMenuSyncAt!: string | null;

  @ApiProperty({ type: SyncGraceStatus })
  grace!: SyncGraceStatus;

  @ApiProperty({ type: SyncOutboxStatus })
  outbox!: SyncOutboxStatus;
}

export class ExtendGraceRequest {
  @ApiProperty({ example: 24, minimum: 1, maximum: 72, description: 'Hours to extend from now (PRD §8.8).' })
  @IsInt()
  @Min(1)
  @Max(72)
  hours!: number;

  @ApiProperty({ example: 'Regional network outage; connector replacement scheduled.', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class GraceOverrideResponse {
  @ApiProperty({ example: '2026-11-23T12:00:00.000Z', description: 'The new effective grace expiry.' })
  until!: string;

  @ApiProperty({ example: 24 })
  hours!: number;
}

export class ReplayOutboxEventResponse {
  @ApiProperty({ example: '3feeb5c0-53fa-476e-a758-3040a3529041' })
  eventId!: string;

  @ApiProperty({ example: 'PENDING', description: 'The re-armed delivery status.' })
  status!: string;
}
