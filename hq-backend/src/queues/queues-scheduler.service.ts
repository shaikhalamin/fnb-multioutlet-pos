import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { JsonLogger } from '../common/logging/logger.service.js';
import type { Env } from '../config/env.schema.js';
import { JOB_NAMES, QUEUES, REPEAT_JOB_IDS } from './queue-names.js';

/**
 * Registers the repeatable `audit-cleanup` job (PRD §13). Registration must
 * never block or crash worker bootstrap: a Redis outage at boot retries in
 * the background against the SAME queue instance — no new connections are
 * opened per retry round.
 */
@Injectable()
export class QueuesSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new JsonLogger('HQ-Worker');
  private stopped = false;

  constructor(
    @InjectQueue(QUEUES.auditCleanup) private readonly auditCleanupQueue: Queue,
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
    const retryIntervalMs = this.config.get('HEARTBEAT_INTERVAL_MS', { infer: true });
    for (;;) {
      try {
        await this.register();
        return;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.logger.warn('queues_scheduler_unavailable', {
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

  /**
   * Repeatable scheduler with a fixed jobId: replicas collapse onto one
   * schedule entry (distributed singleton, PRD §13). Upserting is idempotent.
   */
  private async register(): Promise<void> {
    await this.auditCleanupQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.auditCleanup,
      { every: this.config.get('AUDIT_RETENTION_CHECK_MS', { infer: true }) },
      { name: JOB_NAMES.auditCleanup, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
  }
}
