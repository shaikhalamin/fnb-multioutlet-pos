import { NestFactory } from '@nestjs/core';
import { parseWorkerEnv } from './config/env.schema.js';
import { hqSyncConfig } from './config/hq-sync.config.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { HqCredentialsProvider } from './modules/identity/hq-credentials.provider.js';
import { QUEUES } from './modules/sync/processors/queue-names.js';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

/**
 * Outlet sync-worker entrypoint (PRD §13).
 *
 * Boots the background processors without an HTTP listener. The entire
 * @nestjs/bullmq wiring — the four queues, their consumers and the
 * repeatable schedulers — lives in `SyncWorkerModule`
 * (src/modules/sync/sync-worker.module.ts), composed in by WorkerAppModule;
 * @nestjs/bullmq closes the workers and queues it registered when the
 * application context closes. Jobs carry event IDs only and the processors
 * reload durable rows. Redis/BullMQ unavailability is logged and retried —
 * it never touches the sale path (AT-10); sales commit to the outbox
 * regardless and the sweeper picks the backlog up on recovery.
 */
async function bootstrap(): Promise<void> {
  // Parse (and validate) the worker environment and pin the worker profile
  // BEFORE importing WorkerAppModule: module-graph evaluation runs
  // ConfigModule.forRoot(), whose validation must use the worker contract
  // (HQ machine key required, API auth secrets not).
  const env = parseWorkerEnv();
  const sync = hqSyncConfig(env);

  const logger = new JsonLogger('OUTLET-Worker', { nodeEnv: env.NODE_ENV }, env.NODE_ENV !== 'production');
  logger.setMinLevel(toNestLogLevel(env.LOG_LEVEL));

  const { WorkerAppModule } = await import('./worker-app.module.js');
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { logger, bufferLogs: true });
  app.enableShutdownHooks();

  // HQ credentials live in the `hq_connection` singleton (setup wizard /
  // rotation surface) — the worker reads them per call and may start
  // unpaired. The key ID is not secret; the secret is never logged (§9.2).
  const credentials = app.get(HqCredentialsProvider);
  const pairing = await credentials.refresh().catch(() => null);
  logger.log('outlet_worker_started', {
    hqPaired: pairing !== null,
    hqKeyId: pairing?.keyId ?? null,
    hqApiBaseUrl: pairing?.hqApiBaseUrl ?? null,
    queues: Object.values(QUEUES).join(','),
    menuPullIntervalMs: sync.menuPullIntervalMs,
    outboxSweepIntervalMs: sync.outboxSweepIntervalMs,
  });

  const heartbeatTimer = setInterval(() => {
    logger.log('worker_heartbeat', { uptimeSeconds: Math.floor(process.uptime()) });
  }, sync.heartbeatIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log('worker_stopping', { signal });
    clearInterval(heartbeatTimer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
await bootstrap();
