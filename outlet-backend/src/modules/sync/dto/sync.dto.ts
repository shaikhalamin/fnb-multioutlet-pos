import { ApiProperty } from '@nestjs/swagger';

export class SyncGraceStatus {
  @ApiProperty({ example: 72, description: 'Configured offline grace window in hours (PRD §8.8).' })
  hours!: number;

  @ApiProperty({ example: '2026-11-23T04:00:00.000Z', description: 'When the grace window expires; null when never synced.' })
  expiresAt!: string | null;

  @ApiProperty({ example: false, description: 'True once the grace window has lapsed; new sales are blocked.' })
  expired!: boolean;
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
