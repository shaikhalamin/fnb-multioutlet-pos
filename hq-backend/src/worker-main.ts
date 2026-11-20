import { NestFactory } from '@nestjs/core';
import { parseWorkerEnv } from './config/env.schema.js';
import { JsonLogger } from './common/logging/logger.service.js';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

/**
 * HQ worker entrypoint (PRD §5, §13).
 *
 * Runs the HQ background processors (catalog fan-out, report refresh, audit
 * cleanup) without an HTTP listener. Queue processors register on this
 * application context in later phases; the heartbeat interval keeps the
 * process alive and reports basic liveness until then. The worker never
 * issues human JWTs, so its environment profile omits API auth secrets.
 */
const QUEUES = ['catalog-fanout', 'report-refresh', 'audit-cleanup'] as const;

async function bootstrap(): Promise<void> {
  // Parse (and validate) the worker environment and pin the worker profile
  // BEFORE importing AppModule: module-graph evaluation runs
  // ConfigModule.forRoot(), whose validation must use the worker contract
  // (no API auth secrets required).
  const env = parseWorkerEnv();
  const logger = new JsonLogger('HQ-Worker', { nodeEnv: env.NODE_ENV }, env.NODE_ENV !== 'production');
  const { AppModule } = await import('./app.module.js');
  logger.setMinLevel(toNestLogLevel(env.LOG_LEVEL));

  const app = await NestFactory.createApplicationContext(AppModule, { logger, bufferLogs: true });
  app.enableShutdownHooks();

  logger.log('hq_worker_started', {
    queues: QUEUES.join(','),
    heartbeatMs: env.HEARTBEAT_INTERVAL_MS,
  });

  const heartbeat = setInterval(() => {
    logger.log('worker_heartbeat', { uptimeSeconds: Math.floor(process.uptime()) });
  }, env.HEARTBEAT_INTERVAL_MS);

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
