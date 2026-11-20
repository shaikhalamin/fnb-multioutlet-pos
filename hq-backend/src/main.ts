import { NestFactory } from '@nestjs/core';
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

  const app = await NestFactory.create(AppModule, { logger, bufferLogs: true });
  app.setGlobalPrefix(config.apiPrefix);
  app.useGlobalPipes(makeGlobalValidationPipe());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
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
