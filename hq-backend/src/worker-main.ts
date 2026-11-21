import { NestFactory } from '@nestjs/core';
import { parseWorkerEnv } from './config/env.schema.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { AuditRetentionService } from './modules/audit/audit-retention.service.js';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

/** Retention check cadence: one bounded batch per hour (FR-10). */
const AUDIT_RETENTION_CHECK_MS = 60 * 60 * 1000;

/**
 * HQ worker entrypoint (PRD §5, §13).
 *
 * Runs the HQ background processors without an HTTP listener. Deliberately
 * BullMQ-free (Phase 4 decision): reports are computed on request from the
 * indexed projections, and audit retention runs as a plain interval timer
 * here. The heartbeat interval keeps the process alive and reports basic
 * liveness. The worker never issues human JWTs, so its environment profile
 * omits API auth secrets.
 */
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
    heartbeatMs: env.HEARTBEAT_INTERVAL_MS,
    auditRetentionDays: env.AUDIT_LOG_RETENTION_DAYS,
  });

  const heartbeat = setInterval(() => {
    logger.log('worker_heartbeat', { uptimeSeconds: Math.floor(process.uptime()) });
  }, env.HEARTBEAT_INTERVAL_MS);

  // Hourly audit retention sweep: disabled (0 days) performs no deletes; a
  // failure logs structurally and never kills the worker.
  const auditRetention = app.get(AuditRetentionService);
  const retentionTimer = setInterval(() => {
    void auditRetention
      .runOnce()
      .then((result) => {
        if (result) {
          logger.log('audit_retention_sweep', {
            deleted: result.deleted,
            cutoff: result.cutoff.toISOString(),
          });
        }
      })
      .catch((error: unknown) => {
        logger.error('audit_retention_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, AUDIT_RETENTION_CHECK_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log('worker_stopping', { signal });
    clearInterval(heartbeat);
    clearInterval(retentionTimer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
await bootstrap();
