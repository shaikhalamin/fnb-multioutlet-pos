import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { OutletKeyGuard } from '../../common/auth/outlet-key.guard.js';
import {
  CurrentOutletKey,
  RequireKeyScopes,
  type OutletKeyIdentity,
} from '../../common/auth/require-key-scopes.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import type { Env } from '../../config/env.schema.js';
import { EventBatchRequest, EventBatchResponse } from './dto/event-batch.dto.js';
import { EventIngestService } from './event-ingest.service.js';

/**
 * Outlet event push (PRD §7.4, §8.5): idempotent inbox ingestion with
 * per-event acknowledgements. The batch carries a client `Idempotency-Key`
 * and is bounded by `SYNC_MAX_BODY_BYTES` (413). A dedicated throttle budget
 * (600/min) keeps catch-up pushes clear of the human default (§7.4).
 */
@ApiTags('sync')
@ApiSecurity('outlet-key')
@Public()
@UseGuards(OutletKeyGuard)
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@Controller('sync/v1/events')
export class SyncEventsController {
  constructor(
    private readonly eventIngest: EventIngestService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('batch')
  @RequireKeyScopes('events.push')
  @HttpCode(200)
  @ApiOperation({ summary: 'Push a batch of sync events; per-event acks ride one HTTP 200.' })
  @ApiOkResponse({ type: EventBatchResponse, description: 'Mixed per-event outcomes (§8.5).' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — missing Idempotency-Key' })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED — missing/invalid outlet key' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — key scope or event outlet mismatch (whole request)' })
  @ApiResponse({ status: 413, description: 'Body exceeds SYNC_MAX_BODY_BYTES' })
  async pushBatch(
    @CurrentOutletKey() key: OutletKeyIdentity,
    @Body() body: EventBatchRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<EventBatchResponse> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ApiException('VALIDATION_FAILED', 'The Idempotency-Key header is required for event batches.', 400);
    }
    const maxBytes = this.config.get('SYNC_MAX_BODY_BYTES', { infer: true });
    const declared = Number(contentLength ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ApiException('VALIDATION_FAILED', 'Event batch exceeds the maximum body size.', 413, {
        maxBodyBytes: maxBytes,
      });
    }
    return this.eventIngest.ingestBatch(body, key.outletId);
  }
}
