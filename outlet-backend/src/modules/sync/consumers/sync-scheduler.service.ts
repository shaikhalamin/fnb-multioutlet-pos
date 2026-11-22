import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../../config/env.schema.js';
import { JsonLogger } from '../../../common/logging/logger.service.js';
import { JOB_NAMES, QUEUES, REPEAT_JOB_IDS } from '../processors/queue-names.js';

/**
 * Registers the repeatable sync schedulers (PRD §13). Registration must
 * never block (or crash) worker bootstrap: a Redis outage at boot retries in
 * the background against the SAME queue instances — no new connections are
 * opened per retry round. Fixed jobIds make replicas collapse onto one
 * schedule entry per outlet site (distributed singleton); upserting is
 * idempotent.
 */
@Injectable()
export class SyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new JsonLogger('OUTLET-Worker');
  private stopped = false;

  constructor(
    @InjectQueue(QUEUES.outboxDispatch) private readonly dispatchQueue: Queue,
    @InjectQueue(QUEUES.syncDelivery) private readonly deliveryQueue: Queue,
    @InjectQueue(QUEUES.menuPull) private readonly menuPullQueue: Queue,
    @InjectQueue(QUEUES.syncReconcile) private readonly reconcileQueue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    void this.registerWithRetry();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /** Registers every repeatable scheduler; retries until it succeeds. */
  async registerWithRetry(): Promise<void> {
    const retryIntervalMs = this.config.get('OUTBOX_SWEEP_INTERVAL_MS', { infer: true });
    for (;;) {
      try {
        await this.register();
        return;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.logger.warn('sync_scheduler_unavailable', {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: retryIntervalMs,
        });
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        if (this.stopped) {
          return;
        }
      }
    }
  }

  private async register(): Promise<void> {
    await this.dispatchQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.sweep,
      { every: this.config.get('OUTBOX_SWEEP_INTERVAL_MS', { infer: true }) },
      { name: JOB_NAMES.sweep, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await this.dispatchQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.heartbeat,
      { every: this.config.get('HEARTBEAT_INTERVAL_MS', { infer: true }) },
      { name: JOB_NAMES.heartbeat, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await this.menuPullQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.pull,
      { every: this.config.get('MENU_PULL_INTERVAL_MS', { infer: true }) },
      { name: JOB_NAMES.pull, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await this.reconcileQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.reconcile,
      { every: this.config.get('SYNC_RECONCILE_INTERVAL_MS', { infer: true }) },
      { name: JOB_NAMES.reconcile, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
  }
}
