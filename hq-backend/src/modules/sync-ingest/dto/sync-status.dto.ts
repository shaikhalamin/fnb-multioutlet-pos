import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

/** Money/revision pattern: nonnegative canonical decimal string (PRD §7). */
const DECIMAL_STRING = /^(0|[1-9][0-9]{0,17})$/;

export class SequenceRange {
  @ApiProperty({ example: '94', description: 'First missing sequence — decimal string.' })
  from!: string;

  @ApiProperty({ example: '101', description: 'Last missing sequence — decimal string.' })
  to!: string;
}

export class SyncCheckpointResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({
    example: '108',
    description: 'Highest contiguous accepted sequence — decimal string.',
  })
  highestContiguousSequence!: string;

  @ApiProperty({
    type: [SequenceRange],
    description: 'Sequence ranges accepted above the watermark but not yet contiguous (reconciliation input).',
  })
  missingRanges!: SequenceRange[];
}

export class HeartbeatRequest {
  @ApiProperty({ example: '42', description: 'Menu revision the outlet last applied — decimal string.' })
  @IsString()
  @Matches(DECIMAL_STRING, { message: 'appliedMenuRevision must be a canonical decimal string' })
  appliedMenuRevision!: string;

  @ApiProperty({ example: 3, description: 'Events awaiting delivery at the outlet.' })
  @IsInt()
  @Min(0)
  pendingOutboxCount!: number;

  @ApiProperty({ example: 0, description: 'Events parked for manual repair at the outlet.' })
  @IsInt()
  @Min(0)
  quarantinedCount!: number;

  @ApiPropertyOptional({
    example: '2026-11-20T04:02:03.000Z',
    type: String,
    nullable: true,
    description: 'Oldest undelivered event timestamp, when a backlog exists.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  oldestPendingAt?: string | null;
}

export class HeartbeatResponse {
  @ApiProperty({ example: '2026-11-20T04:02:10.000Z' })
  acknowledgedAt!: string;
}

export class OutletSyncBacklog {
  @ApiProperty({ example: 3 })
  pendingOutboxCount!: number;

  @ApiProperty({ example: 0 })
  quarantinedCount!: number;

  @ApiProperty({ example: '2026-11-20T04:02:03.000Z', type: String, nullable: true })
  oldestPendingAt!: string | null;
}

/** Human `GET /outlets/:id/sync-status` projection (PRD §7.2, FR-10). */
export class OutletSyncStatusResponse {
  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  outletId!: string;

  @ApiProperty({ example: '42', description: 'Current HQ catalog revision — decimal string.' })
  currentMenuRevision!: string;

  @ApiProperty({
    example: '108',
    description: 'Highest contiguous accepted event sequence — decimal string.',
  })
  highestContiguousSequence!: string;

  @ApiProperty({ example: '2026-11-20T04:02:10.000Z', type: String, nullable: true })
  lastEventAt!: string | null;

  @ApiProperty({ example: '2026-11-20T04:03:00.000Z', type: String, nullable: true })
  lastHeartbeatAt!: string | null;

  @ApiProperty({
    example: '42',
    type: String,
    nullable: true,
    description: 'Menu revision the outlet last reported applying — decimal string.',
  })
  lastMenuSeenRevision!: string | null;

  @ApiProperty({
    type: OutletSyncBacklog,
    nullable: true,
    description: 'Backlog as last reported by the outlet heartbeat; null before the first heartbeat.',
  })
  lastReportedBacklog!: OutletSyncBacklog | null;

  @ApiProperty({
    example: 0,
    description: 'Quarantined events at the outlet, as last reported (HQ never sees outlet rows directly).',
  })
  quarantinedCount!: number;
}
