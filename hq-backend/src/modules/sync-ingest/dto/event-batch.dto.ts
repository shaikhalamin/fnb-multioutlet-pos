import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Money/sequence pattern: nonnegative canonical decimal string (PRD §7). */
const MONEY_MINOR = /^(0|[1-9][0-9]{0,17})$/;
const RECEIPT_NO = /^[A-Za-z0-9_-]+-[0-9]{1,19}$/;

const moneyDescription = 'Minor units, canonical decimal string.';

export class SyncEventItemRequest {
  @ApiProperty({ example: '64750166-32a4-46f8-9285-f536f5b03213' })
  @IsUUID()
  saleItemId!: string;

  @ApiProperty({ example: '9708835e-2e21-465a-87e9-5f8d56cd44ab' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ example: 'Chicken Burger' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nameSnapshot!: string;

  @ApiProperty({ example: 'BURGER-01' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  skuSnapshot!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @ApiProperty({ example: '1200', description: moneyDescription })
  @IsString()
  @Matches(MONEY_MINOR, { message: 'unitPriceMinor must be a canonical decimal string' })
  unitPriceMinor!: string;

  @ApiProperty({ example: '2400', description: moneyDescription })
  @IsString()
  @Matches(MONEY_MINOR, { message: 'subtotalMinor must be a canonical decimal string' })
  subtotalMinor!: string;
}

export class SyncEventDataRequest {
  @ApiProperty({ example: '0a44e56a-628e-492a-81e0-83f4a4d68f76' })
  @IsUUID()
  saleId!: string;

  @ApiProperty({ example: 'A-000001' })
  @IsString()
  @Matches(RECEIPT_NO, { message: 'receiptNo must be <prefix>-<number>' })
  receiptNo!: string;

  @ApiProperty({ example: '42', description: 'Local catalog revision — decimal string.' })
  @IsString()
  @Matches(MONEY_MINOR, { message: 'catalogRevision must be a canonical decimal string' })
  catalogRevision!: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be ISO 4217 alpha-3' })
  currencyCode!: string;

  @ApiProperty({ enum: ['COMPLETED'] })
  @IsIn(['COMPLETED'])
  status!: string;

  @ApiProperty({ example: '2026-11-20T04:02:03Z' })
  @IsISO8601({ strict: true })
  soldAt!: string;

  @ApiProperty({ example: '3900', description: moneyDescription })
  @IsString()
  @Matches(MONEY_MINOR, { message: 'totalMinor must be a canonical decimal string' })
  totalMinor!: string;

  @ApiProperty({ type: [SyncEventItemRequest], maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SyncEventItemRequest)
  items!: SyncEventItemRequest[];
}

/** `contracts/sync-event-v1.schema.json` as a request DTO (PRD §8.4). */
export class SyncEventV1 {
  @ApiProperty({ example: '3feeb5c0-53fa-476e-a758-3040a3529041', description: 'Equals the outlet outbox row ID.' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ enum: ['sale.completed'] })
  @IsIn(['sale.completed'])
  eventType!: string;

  @ApiProperty({ example: 1, description: 'Schema version; HQ supports 1 and rejects others per event.' })
  @IsInt()
  schemaVersion!: number;

  @ApiProperty({ example: '61de28db-92ed-46ef-9d90-3a951ac03420' })
  @IsUUID()
  outletId!: string;

  @ApiProperty({ example: '108', description: 'Per-outlet contiguous sequence — decimal string.' })
  @IsString()
  @Matches(MONEY_MINOR, { message: 'sequenceNo must be a canonical decimal string' })
  sequenceNo!: string;

  @ApiProperty({ example: '2026-11-20T04:02:03Z' })
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @ApiProperty({ type: SyncEventDataRequest })
  @ValidateNested()
  @Type(() => SyncEventDataRequest)
  data!: SyncEventDataRequest;
}

export class EventBatchRequest {
  @ApiProperty({ example: '047bfdb5-727a-47eb-970a-03a038c11b92' })
  @IsUUID()
  batchId!: string;

  @ApiProperty({ type: [SyncEventV1], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SyncEventV1)
  events!: SyncEventV1[];
}

export type EventOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED_PERMANENT' | 'RETRYABLE_ERROR';

export class EventBatchResult {
  @ApiProperty({ example: '3feeb5c0-53fa-476e-a758-3040a3529041' })
  eventId!: string;

  @ApiProperty({ enum: ['ACCEPTED', 'DUPLICATE', 'REJECTED_PERMANENT', 'RETRYABLE_ERROR'] })
  status!: EventOutcome;

  @ApiProperty({ example: false, description: 'True when the outlet should retry this event unchanged.' })
  retryable!: boolean;

  @ApiPropertyOptional({
    example: '2026-11-20T04:02:10Z',
    type: String,
    nullable: true,
    description: 'Present for terminal successes (ACCEPTED, DUPLICATE); null otherwise.',
  })
  acknowledgedAt?: string | null;

  @ApiPropertyOptional({
    example: 'UNSUPPORTED_EVENT_VERSION',
    type: String,
    nullable: true,
    description: 'Stable reason code for non-success outcomes (e.g. UNSUPPORTED_EVENT_VERSION, EVENT_ID_CONFLICT).',
  })
  detail?: string | null;
}

export class EventBatchResponse {
  @ApiProperty({ example: '047bfdb5-727a-47eb-970a-03a038c11b92' })
  batchId!: string;

  @ApiProperty({ type: [EventBatchResult] })
  results!: EventBatchResult[];

  @ApiProperty({
    example: '108',
    description: 'Highest contiguous accepted sequence for the outlet — decimal string.',
  })
  highestContiguousSequence!: string;
}
