import { NestFactory } from '@nestjs/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { parseWorkerEnv } from './config/env.schema.js';
import { hqSyncConfig } from './config/hq-sync.config.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { MenuPullProcessor } from './modules/sync/processors/menu-pull.processor.js';
import { JOB_NAMES, QUEUES, REPEAT_JOB_IDS } from './modules/sync/processors/queue-names.js';
import { OutboxSweepProcessor } from './modules/sync/processors/outbox-sweep.processor.js';
import { SyncDeliveryProcessor } from './modules/sync/processors/sync-delivery.processor.js';
import { SyncHeartbeatProcessor, SyncReconcileProcessor } from './modules/sync/processors/sync-reconcile.processor.js';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

async function bootstrap(): Promise<void> {
  // Parse (and validate) the worker environment and pin the worker profile
  // BEFORE importing AppModule: module-graph evaluation runs
  // ConfigModule.forRoot(), whose validation must use the worker contract
  // (HQ machine key required, API auth secrets not).
  const env = parseWorkerEnv();
  const sync = hqSyncConfig(env);

  const logger = new JsonLogger(
    'OUTLET-Worker',
    { nodeEnv: env.NODE_ENV, outletCode: env.OUTLET_CODE },
    env.NODE_ENV !== 'production',
  );
  logger.setMinLevel(toNestLogLevel(env.LOG_LEVEL));

  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { logger, bufferLogs: true });
  app.enableShutdownHooks();

  const sweeper = app.get(OutboxSweepProcessor);
  const delivery = app.get(SyncDeliveryProcessor);
  const menuPull = app.get(MenuPullProcessor);
  const reconciler = app.get(SyncReconcileProcessor);
  const heartbeat = app.get(SyncHeartbeatProcessor);

  logger.log('outlet_worker_started', {
    outletId: sync.outletId,
    outletCode: sync.outletCode,
    // Key ID is not secret; the secret is never logged (PRD §9.2).
    hqKeyId: sync.hqKeyId,
    hqApiBaseUrl: sync.hqApiBaseUrl,
    queues: Object.values(QUEUES).join(','),
    menuPullIntervalMs: sync.menuPullIntervalMs,
    outboxSweepIntervalMs: sync.outboxSweepIntervalMs,
  });

  // ---- BullMQ wiring (PRD §13) -------------------------------------------------
  // Plain instances, not request-scoped DI: jobs carry event IDs only and the
  // processors reload durable rows. Redis/BullMQ unavailability is logged and
  // retried — it never touches the sale path (AT-10); sales commit to the
  // outbox regardless and the sweeper picks the backlog up on recovery.
  // Queues are created ONCE, before any retry loop: re-entering the
  // scheduler registration must never construct new Queue instances, or a
  // Redis outage leaks a reconnecting connection per retry round.
  const connection: ConnectionOptions = { url: env.REDIS_URL };
  const deliveryQueue = new Queue(QUEUES.syncDelivery, { connection });
  const dispatchQueue = new Queue(QUEUES.outboxDispatch, { connection });
  const menuPullQueue = new Queue(QUEUES.menuPull, { connection });
  const reconcileQueue = new Queue(QUEUES.syncReconcile, { connection });

  const workers: Worker[] = [];
  const queues: Queue[] = [deliveryQueue, dispatchQueue, menuPullQueue, reconcileQueue];

  const sweepWorker = new Worker(
    QUEUES.outboxDispatch,
    async (job) => {
      if (job.name === JOB_NAMES.sweep) {
        const eventIds = await sweeper.sweep();
        if (eventIds.length > 0) {
          await deliveryQueue.add(JOB_NAMES.deliver, { eventIds }, { attempts: 3, backoff: { type: 'exponential', delay: 2_000 } });
        }
      } else if (job.name === JOB_NAMES.heartbeat) {
        // Backlog/menu-revision report; failures are non-fatal by contract.
        await heartbeat.beat();
      }
    },
    { connection, concurrency: 1 },
  );
  workers.push(sweepWorker);

  const deliveryWorker = new Worker(
    QUEUES.syncDelivery,
    async (job) => {
      const eventIds = (job.data as { eventIds?: string[] }).eventIds ?? [];
      const outcome = await delivery.deliver(eventIds);
      if (outcome.delivered + outcome.retried + outcome.quarantined > 0) {
        logger.log('sync_delivery_batch', { ...outcome });
      }
    },
    { connection, concurrency: 1 },
  );
  workers.push(deliveryWorker);

  const menuPullWorker = new Worker(QUEUES.menuPull, async () => menuPull.pull(), {
    connection,
    concurrency: 1,
  });
  workers.push(menuPullWorker);

  const reconcileWorker = new Worker(QUEUES.syncReconcile, async () => reconciler.reconcile(), {
    connection,
    concurrency: 1,
  });
  workers.push(reconcileWorker);

  for (const worker of workers) {
    worker.on('error', (error) => logger.warn('sync_worker_error', { queue: worker.name, error: error.message }));
  }

  // Repeatable schedulers with fixed jobIds: replicas collapse onto one
  // schedule entry per outlet site (distributed singleton, PRD §13). Adding
  // the repeatable is idempotent; a Redis outage retries via the loop below
  // against the SAME queue instances — no new connections are opened.
  const schedule = async (): Promise<void> => {
    await dispatchQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.sweep,
      { every: sync.outboxSweepIntervalMs },
      { name: JOB_NAMES.sweep, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await dispatchQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.heartbeat,
      { every: sync.heartbeatIntervalMs },
      { name: JOB_NAMES.heartbeat, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await menuPullQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.pull,
      { every: sync.menuPullIntervalMs },
      { name: JOB_NAMES.pull, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
    await reconcileQueue.upsertJobScheduler(
      REPEAT_JOB_IDS.reconcile,
      { every: env.SYNC_RECONCILE_INTERVAL_MS },
      { name: JOB_NAMES.reconcile, data: {}, opts: { removeOnComplete: { count: 20 } } },
    );
  };
  const scheduleWithRetry = async (): Promise<void> => {
    for (;;) {
      try {
        await schedule();
        return;
      } catch (error) {
        logger.warn('sync_scheduler_unavailable', {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: sync.outboxSweepIntervalMs,
        });
        await new Promise((resolve) => setTimeout(resolve, sync.outboxSweepIntervalMs));
      }
    }
  };
  void scheduleWithRetry();

  const heartbeatTimer = setInterval(() => {
    logger.log('worker_heartbeat', { uptimeSeconds: Math.floor(process.uptime()) });
  }, sync.heartbeatIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log('worker_stopping', { signal });
    clearInterval(heartbeatTimer);
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await Promise.allSettled(queues.map((queue) => queue.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
await bootstrap();
