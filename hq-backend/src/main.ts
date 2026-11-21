import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { loadAppConfig } from './config/app.config.js';
import { parseApiEnv } from './config/env.schema.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { makeGlobalValidationPipe } from './common/validation/global-validation.pipe.js';
import { buildOpenApiDocument } from './openapi/document.js';
import { SwaggerModule } from '@nestjs/swagger';

/** Env log level → NestJS LoggerService level. */
function toNestLogLevel(level: string): 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose' {
  if (level === 'info') return 'log';
  if (level === 'trace') return 'verbose';
  return level as 'fatal' | 'error' | 'warn' | 'debug';
}

async function bootstrap(): Promise<void> {
  // Parses (and validates) the environment and pins the API profile before
  // the module graph is imported: AppModule evaluation runs
  // ConfigModule.forRoot(), which validates the same contract again for
  // ConfigService. The same validated config is then served through
  // ConfigurationModule.
  const env = parseApiEnv();
  const config = loadAppConfig(env);
  const { AppModule } = await import('./app.module.js');
  const logger = new JsonLogger('HQ-API', { nodeEnv: config.nodeEnv }, !config.isProduction);
  logger.setMinLevel(toNestLogLevel(config.logLevel));

  // `bodyParser: false` + an explicit JSON parser lets the machine sync
  // batch route use the full SYNC_MAX_BODY_BYTES budget (§8.5, default 1 MiB)
  // instead of the Express 100 KiB default.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    bufferLogs: true,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: config.syncMaxBodyBytes });
  app.setGlobalPrefix(config.apiPrefix);
  // Refresh cookies (`hq_rt`) are read on /auth/refresh|logout (PRD §9.1).
  app.use(cookieParser());
  // CORS is allowed only for the HQ web origin AND never for the machine
  // sync surface: `/sync/v1/*` must not be browser-accessible at all
  // (PRD §9.2 — keys live server-side only).
  app.use((req: Request, res: Response, next: () => void) => {
    const origin = req.headers.origin;
    if (!origin || req.path.startsWith(`/${config.apiPrefix}/sync/v1/`)) {
      next();
      return;
    }
    if (config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Request-Id,Idempotency-Key');
        res.sendStatus(204);
        return;
      }
    }
    next();
  });
  app.useGlobalPipes(makeGlobalValidationPipe());
  app.enableShutdownHooks();

  if (config.swaggerEnabled || config.openApiExport) {
    // Swagger UI + machine-readable JSON document (PRD §7); enable only in
    // development/admin-restricted environments.
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document, {
      jsonDocumentUrl: 'openapi.json',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(config.port, '0.0.0.0');
  logger.log('hq_api_started', {
    port: config.port,
    apiPrefix: config.apiPrefix,
    swagger: config.swaggerEnabled,
  });
}
await bootstrap();
