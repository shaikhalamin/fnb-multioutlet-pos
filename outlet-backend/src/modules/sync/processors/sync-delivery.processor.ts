import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import type { Env } from '../../../config/env.schema.js';
import type { OutboxEventEntity } from '../../../database/entities/outbox-event.entity.js';
import { OutletAuditService } from '../../audit/outlet-audit.service.js';
import { computeBackoffDelayMs } from '../../outbox/outbox.repository.js';
// Value import (not `import type`): the class is an injection token.
import { OutboxRepository } from '../../outbox/outbox.repository.js';
import { HqSyncClient, HqSyncError } from '../clients/hq-sync.client.js';
import type { SyncEventV1 } from '../clients/generated/types/SyncEventV1.js';

/** Batch transport ceiling (§8.5: limit batch size, e.g. 100 events / 1 MiB). */
const MAX_BATCH_BYTES = 1_048_576;

export type DeliveryOutcome = { delivered: number; retried: number; quarantined: number };

/**
 * Deterministic `Idempotency-Key` for a logical batch (§8.5): derived from
 * the sorted event IDs, so a BullMQ job retry of the same rows reuses the
 * exact key a transport-level retry would — same bytes in, same key out. A
 * different row set (e.g. after partial per-event acks) is a different
 * logical batch and derives a different key.
 */
function batchIdempotencyKey(eventIds: string[]): string {
  const hash = createHash('sha256').update([...eventIds].sort().join('\n')).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Sync delivery (PRD §8.5–§8.6 C–F): loads durable rows by event ID, splits
 * into size/byte-bounded batches, and pushes each with ONE minted
 * `Idempotency-Key` (stable for this logical batch attempt). Rows are marked
 * `DELIVERED` only after an HQ `ACCEPTED`/`DUPLICATE` ack — never before
 * (§8.6 D). Retryable faults back off exponentially; permanent conflicts are
 * quarantined (never deleted) with an operator alert.
 */
@Injectable()
export class SyncDeliveryProcessor {
  private readonly logger = new JsonLogger('SyncDelivery');
  private readonly maxBatchSize: number;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly hq: HqSyncClient,
    private readonly audit: OutletAuditService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBatchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
  }

  async deliver(eventIds: string[], now = new Date()): Promise<DeliveryOutcome> {
    const rows = (await this.outbox.findByIds(eventIds)).filter(
      (row) =>
        (row.status === 'PENDING' || row.status === 'RETRY') &&
        // BullMQ's own job retries (2s exponential) can fire long before a
        // previously computed backoff elapses (e.g. 429 + Retry-After 60s):
        // rows not yet due are left for the sweeper, which re-leases them
        // when next_attempt_at passes.
        (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= now.getTime()),
    );
    if (rows.length === 0) return { delivered: 0, retried: 0, quarantined: 0 };

    const outcome: DeliveryOutcome = { delivered: 0, retried: 0, quarantined: 0 };
    for (const batch of this.splitBatches(rows)) {
      const batchOutcome = await this.deliverBatch(batch, now);
      outcome.delivered += batchOutcome.delivered;
      outcome.retried += batchOutcome.retried;
      outcome.quarantined += batchOutcome.quarantined;
    }
    return outcome;
  }

  /** Greedy grouping by count and serialized bytes (§8.5 batch limits). */
  private splitBatches(rows: OutboxEventEntity[]): OutboxEventEntity[][] {
    const batches: OutboxEventEntity[][] = [];
    let current: OutboxEventEntity[] = [];
    let bytes = 0;
    for (const row of rows) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row.payload));
      if (current.length >= this.maxBatchSize || (current.length > 0 && bytes + rowBytes > MAX_BATCH_BYTES)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(row);
      bytes += rowBytes;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private async deliverBatch(batch: OutboxEventEntity[], now: Date): Promise<DeliveryOutcome> {
    const startedAt = Date.now();
    const events = batch.map((row) => row.payload as unknown as SyncEventV1);
    // One key per logical batch: derived from the sorted event IDs so both a
    // transport retry and a BullMQ job retry of the same rows reuse it (§8.5).
    const idempotencyKey = batchIdempotencyKey(batch.map((row) => row.id));

    try {
      const response = await this.hq.pushEventBatch(events, idempotencyKey);
      return await this.applyPerEventResults(batch, response.results, Date.now() - startedAt, now);
    } catch (error) {
      return this.applyBatchLevelFailure(batch, error, Date.now() - startedAt, now);
    }
  }

  private async applyPerEventResults(
    batch: OutboxEventEntity[],
    results: ReadonlyArray<{ eventId: string; status: string; detail?: string | null }>,
    durationMs: number,
    now: Date,
  ): Promise<DeliveryOutcome> {
    const byEventId = new Map(results.map((result) => [result.eventId, result]));
    const delivered: string[] = [];
    const retried: string[] = [];
    let retriedError: string | null = null;
    let quarantined = 0;

    for (const row of batch) {
      const result = byEventId.get(row.id);
      if (!result) {
        // HQ answered 200 but skipped this event: not acknowledged — retry.
        retried.push(row.id);
        retriedError = 'HQ_ACK_MISSING';
        continue;
      }
      if (result.status === 'ACCEPTED' || result.status === 'DUPLICATE') {
        delivered.push(row.id); // §8.6 D: mark delivered only after the ack
        await this.outbox.appendAttemptLog({
          outboxEventId: row.id,
          statusCode: 200,
          durationMs,
          errorCode: null,
        });
      } else if (result.status === 'RETRYABLE_ERROR') {
        retried.push(row.id);
        retriedError = result.detail ?? 'RETRYABLE_ERROR';
        await this.outbox.appendAttemptLog({
          outboxEventId: row.id,
          statusCode: 200,
          durationMs,
          errorCode: result.detail ?? 'RETRYABLE_ERROR',
        });
      } else {
        // REJECTED_PERMANENT: quarantine, never delete, alert the operator (§8.6 F).
        quarantined += 1;
        await this.outbox.markQuarantined(row.id, result.detail ?? 'REJECTED_PERMANENT');
        await this.audit.record({
          actorType: 'SYSTEM',
          action: 'sync.event_quarantined',
          entityId: row.id,
          metadata: {
            sequenceNo: row.sequenceNo,
            detail: result.detail ?? 'REJECTED_PERMANENT',
            eventType: row.eventType,
          },
        });
        await this.outbox.appendAttemptLog({
          outboxEventId: row.id,
          statusCode: 200,
          durationMs,
          errorCode: result.detail ?? 'REJECTED_PERMANENT',
        });
        this.logger.error('sync_event_quarantined', {
          eventId: row.id,
          sequenceNo: row.sequenceNo,
          detail: result.detail,
        });
      }
    }

    if (delivered.length > 0) {
      await this.outbox.markDelivered(delivered, now);
    }
    if (retried.length > 0) {
      const retriedRow = batch.find((row) => row.id === retried[0]);
      const delay = computeBackoffDelayMs(retriedRow?.attempts ?? 1);
      await this.outbox.markRetry(retried, retriedError ?? 'RETRYABLE_ERROR', delay, now);
    }
    return { delivered: delivered.length, retried: retried.length, quarantined };
  }

  private async applyBatchLevelFailure(
    batch: OutboxEventEntity[],
    error: unknown,
    durationMs: number,
    now: Date,
  ): Promise<DeliveryOutcome> {
    const ids = batch.map((row) => row.id);
    const status = error instanceof HqSyncError ? error.status : null;
    const code = error instanceof HqSyncError ? error.code : 'HQ_UNREACHABLE';
    const message = error instanceof Error ? error.message : String(error);
    const retryableBatch =
      status === null || // network/timeout/contract mismatch
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status >= 500;

    await Promise.all(
      batch.map((row) =>
        this.outbox.appendAttemptLog({ outboxEventId: row.id, statusCode: status, durationMs, errorCode: code }),
      ),
    );

    if (retryableBatch) {
      const retryAfterSeconds = error instanceof HqSyncError ? error.retryAfterSeconds : null;
      const delay = computeBackoffDelayMs(batch[0]?.attempts ?? 1, retryAfterSeconds);
      await this.outbox.markRetry(ids, message, delay, now);
      this.logger.warn('sync_batch_retry_scheduled', { count: ids.length, code, delayMs: delay });
      return { delivered: 0, retried: ids.length, quarantined: 0 };
    }

    // Non-retryable batch faults (400/401/403/413): operator action is
    // required (key rotation, re-batching) — quarantine rather than burn
    // retries forever (§8.7 "avoid 401 infinite retries").
    for (const row of batch) {
      await this.outbox.markQuarantined(row.id, `${code}: ${message}`);
      await this.audit.record({
        actorType: 'SYSTEM',
        action: 'sync.batch_quarantined',
        entityId: row.id,
        metadata: { status, code, sequenceNo: row.sequenceNo },
      });
    }
    this.logger.error('sync_batch_quarantined', { count: ids.length, status, code });
    return { delivered: 0, retried: 0, quarantined: ids.length };
  }
}
