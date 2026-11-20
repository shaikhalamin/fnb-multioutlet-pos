import { NestFactory } from '@nestjs/core';
import { parseWorkerEnv } from './config/env.schema.js';
import { hqSyncConfig } from './config/hq-sync.config.js';
import { JsonLogger } from './common/logging/logger.service.js';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

/**
 * Outlet worker entrypoint (PRD §5, §8).
 *
 * Runs the outlet-initiated synchronization processors (menu pull, outbox
 * dispatch, sync delivery, reconciliation) without an HTTP listener. All HQ
 * communication is outbound-only from this worker; the machine key is loaded
 * from the server-side environment and never logged. The worker uses no
 * outlet user JWTs, so its environment profile omits API auth secrets.
 */
const QUEUES = ['menu-pull', 'outbox-dispatch', 'sync-delivery', 'sync-reconcile'] as const;

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

  logger.log('outlet_worker_started', {
    outletId: sync.outletId,
    outletCode: sync.outletCode,
    // Key ID is not secret; the secret is never logged (PRD §9.2).
    hqKeyId: sync.hqKeyId,
    hqApiBaseUrl: sync.hqApiBaseUrl,
    queues: QUEUES.join(','),
    menuPullIntervalMs: sync.menuPullIntervalMs,
    outboxSweepIntervalMs: sync.outboxSweepIntervalMs,
  });

  const heartbeat = setInterval(() => {
    logger.log('worker_heartbeat', { uptimeSeconds: Math.floor(process.uptime()) });
  }, sync.heartbeatIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log('worker_stopping', { signal });
    clearInterval(heartbeat);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
await bootstrap();
