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
 * Runs the HQ background processors without an HTTP listener. The
 * @nestjs/bullmq wiring — the `audit-cleanup` queue, its consumer and the
 * repeatable scheduler — lives in `QueuesModule` (src/queues/), composed in
 * by WorkerAppModule; @nestjs/bullmq closes the workers and queues it
 * registered when the application context closes. Reports stay computed on
 * request from the indexed projections, and catalog fan-out stays
 * transactional — neither gets a queue. The heartbeat interval keeps the
 * process alive and reports basic liveness. The worker never issues human
 * JWTs, so its environment profile omits API auth secrets.
 */
async function bootstrap(): Promise<void> {
  // Parse (and validate) the worker environment and pin the worker profile
  // BEFORE importing WorkerAppModule: module-graph evaluation runs
  // ConfigModule.forRoot(), whose validation must use the worker contract
  // (no API auth secrets required).
  const env = parseWorkerEnv();
  const logger = new JsonLogger('HQ-Worker', { nodeEnv: env.NODE_ENV }, env.NODE_ENV !== 'production');
  const { WorkerAppModule } = await import('./worker-app.module.js');
  logger.setMinLevel(toNestLogLevel(env.LOG_LEVEL));

  const app = await NestFactory.createApplicationContext(WorkerAppModule, { logger, bufferLogs: true });
  app.enableShutdownHooks();

  logger.log('hq_worker_started', {
    heartbeatMs: env.HEARTBEAT_INTERVAL_MS,
    auditRetentionDays: env.AUDIT_LOG_RETENTION_DAYS,
    auditRetentionCheckMs: env.AUDIT_RETENTION_CHECK_MS,
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
