import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { sha256OfCanonicalJson } from '../../common/utils/canonical-json.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  EventBatchRequest,
  EventBatchResponse,
  EventBatchResult,
  SyncEventV1,
} from './dto/event-batch.dto.js';
// Value imports (not `import type`): classes are injection tokens.
import { SyncCheckpointRepository } from './sync-checkpoint.repository.js';
import { SyncInboxRepository } from './sync-inbox.repository.js';

/** Currently supported sync-event schema version (PRD §8.4). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Transactional event ingest (PRD §8.5–§8.6): per event, ONE HQ PostgreSQL
 * transaction covers dedupe lookup, inbox insert, projection writes and the
 * contiguous-checkpoint advance. Mixed per-event outcomes ride a single HTTP
 * 200; whole-request failures (auth, outlet mismatch, size) abort the batch.
 */
@Injectable()
export class EventIngestService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly inbox: SyncInboxRepository,
    private readonly checkpoints: SyncCheckpointRepository,
    private readonly audit: AuditService,
  ) {}

  async ingestBatch(request: EventBatchRequest, keyOutletId: string): Promise<EventBatchResponse> {
    // The outlet identity comes only from the key record: any event claiming
    // another outlet rejects the ENTIRE request (PRD §7.4, AT-16).
    for (const event of request.events) {
      if (event.outletId !== keyOutletId) {
        throw new ApiException('FORBIDDEN', 'Event outlet does not match the authenticated key.', 403, {
          eventOutletId: event.outletId,
        });
      }
    }

    const results: EventBatchResult[] = [];
    for (const event of request.events) {
      results.push(await this.ingestOne(event));
    }

    const checkpoint = await this.checkpoints.find(keyOutletId);
    return {
      batchId: request.batchId,
      results,
      highestContiguousSequence: checkpoint?.highestContiguousSequence ?? '0',
    };
  }

  private async ingestOne(event: SyncEventV1): Promise<EventBatchResult> {
    const now = new Date();

    // Unknown required versions are rejected permanently — never silently
    // ignored (PRD §8.4).
    if (event.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      return this.result(event, 'REJECTED_PERMANENT', 'UNSUPPORTED_EVENT_VERSION', now);
    }

    // Integrity invariants re-verified in bigint (§8.4): quantity × price =
    // subtotal; Σ subtotal = total. Validation is defense-in-depth.
    const invariant = saleInvariantError(event);
    if (invariant !== null) {
      return this.result(event, 'REJECTED_PERMANENT', invariant, now);
    }

    const payloadSha256 = sha256OfCanonicalJson(event);

    try {
      return await this.dataSource.transaction(async (manager) => {
        const byId = await this.inbox.findInboxEvent(manager, event.outletId, event.eventId);
        if (byId) {
          if (byId.payloadSha256 === payloadSha256) {
            // Same canonical payload: terminal success (AT-09).
            return this.result(event, 'DUPLICATE', null, now);
          }
          // Identity reuse with a different payload: never overwrite the
          // original; flag for security audit (AT-15).
          await this.audit.record(
            {
              actorType: 'OUTLET_KEY',
              action: 'sync.event_id_conflict',
              entityType: 'sync_inbox_event',
              entityId: null,
              metadata: {
                outletId: event.outletId,
                eventId: event.eventId,
                sequenceNo: event.sequenceNo,
                conflict: 'payload_hash_mismatch',
              },
            },
            manager,
          );
          return this.result(event, 'REJECTED_PERMANENT', 'EVENT_ID_CONFLICT', now);
        }

        const bySequence = await this.inbox.findInboxEventBySequence(manager, event.outletId, event.sequenceNo);
        if (bySequence && bySequence.eventId !== event.eventId) {
          await this.audit.record(
            {
              actorType: 'OUTLET_KEY',
              action: 'sync.event_id_conflict',
              entityType: 'sync_inbox_event',
              entityId: null,
              metadata: {
                outletId: event.outletId,
                eventId: event.eventId,
                sequenceNo: event.sequenceNo,
                conflict: 'sequence_reuse',
                existingEventId: bySequence.eventId,
              },
            },
            manager,
          );
          return this.result(event, 'REJECTED_PERMANENT', 'EVENT_ID_CONFLICT', now);
        }

        // Inbox + projection + checkpoint advance: one transaction (§8.6).
        await this.checkpoints.lockCheckpointRow(manager, event.outletId);
        await this.inbox.insertAcceptedEvent(manager, event, payloadSha256);
        await this.checkpoints.advanceContiguous(manager, event.outletId, now);
        return this.result(event, 'ACCEPTED', null, now);
      });
    } catch (error) {
      // A uniqueness race means another request committed the same identity
      // first — collapse to the dedupe outcome instead of a retry loop.
      const constraint = uniqueViolationConstraint(error);
      if (constraint === 'uq_hq_inbox_event' || constraint === 'uq_hq_inbox_sequence') {
        const committed = await this.inbox.findInboxEvent(this.dataSource, event.outletId, event.eventId);
        if (committed?.payloadSha256 === payloadSha256) {
          return this.result(event, 'DUPLICATE', null, now);
        }
        return this.result(event, 'REJECTED_PERMANENT', 'EVENT_ID_CONFLICT', now);
      }
      if (constraint === 'uq_hq_sale_source') {
        return this.result(event, 'REJECTED_PERMANENT', 'EVENT_ID_CONFLICT', now);
      }
      if (constraint === 'uq_hq_receipt') {
        // A different accepted sale already owns this receipt number.
        return this.result(event, 'REJECTED_PERMANENT', 'RECEIPT_CONFLICT', now);
      }
      return this.result(event, 'RETRYABLE_ERROR', 'TRANSACTION_FAILED', now);
    }
  }

  private result(
    event: SyncEventV1,
    status: EventBatchResult['status'],
    detail: string | null,
    now: Date,
  ): EventBatchResult {
    const terminalSuccess = status === 'ACCEPTED' || status === 'DUPLICATE';
    return {
      eventId: event.eventId,
      status,
      retryable: status === 'RETRYABLE_ERROR',
      acknowledgedAt: terminalSuccess ? now.toISOString() : null,
      detail,
    };
  }
}

/** PRD §8.4 integrity invariants, all arithmetic in bigint. */
export function saleInvariantError(event: SyncEventV1): string | null {
  let total = 0n;
  for (const item of event.data.items) {
    const subtotal = BigInt(item.quantity) * BigInt(item.unitPriceMinor);
    if (subtotal !== BigInt(item.subtotalMinor)) {
      return 'INVARIANT_LINE_SUBTOTAL';
    }
    total += subtotal;
  }
  if (total !== BigInt(event.data.totalMinor)) {
    return 'INVARIANT_TOTAL';
  }
  return null;
}

function uniqueViolationConstraint(error: unknown): string | null {
  const candidate = error as { constraint?: string; driverError?: { constraint?: string }; code?: string };
  if (candidate?.code !== '23505' && candidate?.driverError?.code !== '23505') return null;
  return candidate.constraint ?? candidate.driverError?.constraint ?? null;
}
