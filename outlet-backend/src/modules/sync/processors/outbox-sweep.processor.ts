import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema.js';
// Value import (not `import type`): the class is an injection token.
import { OutboxRepository } from '../../outbox/outbox.repository.js';

/**
 * Outbox sweeper (PRD §8.6 A/G, §8.7): the periodic scanner — not BullMQ
 * scheduling — is the source of truth for retry eligibility. Expired leases
 * revert to eligible first, then one batch is leased `FOR UPDATE SKIP
 * LOCKED` and its event IDs are handed to the delivery queue. Redis or
 * scheduler failures never touch committed sales (AT-10): the sweeper just
 * runs again.
 */
@Injectable()
export class OutboxSweepProcessor {
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly outbox: OutboxRepository,
    config: ConfigService<Env, true>,
  ) {
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    const sweepIntervalMs = config.get('OUTBOX_SWEEP_INTERVAL_MS', { infer: true });
    // A lease spans several sweep intervals before expiry reclaims stalled work.
    this.leaseMs = Math.max(sweepIntervalMs * 3, 15_000);
  }

  /** Returns the leased event IDs for the delivery queue (IDs only, §13). */
  async sweep(now = new Date()): Promise<string[]> {
    await this.outbox.expireLeases(now);
    const rows = await this.outbox.leaseDueBatch(this.batchSize, this.leaseMs, now);
    return rows.map((row) => row.id);
  }
}
