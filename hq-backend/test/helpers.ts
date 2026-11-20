import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { API_PREFIX } from '../src/config/app.config.js';
import { makeGlobalValidationPipe } from '../src/common/validation/global-validation.pipe.js';

/**
 * Shared e2e app bootstrap so specs mirror `main.ts` wiring: global prefix,
 * cookie parsing for the refresh cookie, and the global validation pipe.
 */
export function configureE2eApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  app.useGlobalPipes(makeGlobalValidationPipe());
  return app;
}
