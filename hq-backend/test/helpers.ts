import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX, loadAppConfig } from '../src/config/app.config.js';
import { parseApiEnv } from '../src/config/env.schema.js';
import { makeGlobalValidationPipe } from '../src/common/validation/global-validation.pipe.js';

/**
 * Shared e2e app bootstrap so specs mirror `main.ts` wiring: global prefix,
 * the explicit JSON parser with the SYNC_MAX_BODY_BYTES budget (so the 413
 * size-limit path is exercised exactly as in production), cookie parsing for
 * the refresh cookie, and the global validation pipe.
 */
export function configureE2eApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX);
  app.useBodyParser('json', { limit: loadAppConfig(parseApiEnv()).syncMaxBodyBytes });
  app.use(cookieParser());
  app.useGlobalPipes(makeGlobalValidationPipe());
  return app;
}
