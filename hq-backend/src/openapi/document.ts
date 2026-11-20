import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '../config/app.config.js';

/**
 * Builds the machine-readable HQ API contract (PRD §7). The exported JSON
 * artifact (`openapi/openapi.json`, regenerated via `pnpm openapi:export`) is the input for the
 * Kubb client generation pipeline in `hq-frontend` (PRD §11).
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('F&B Platform — HQ API')
    .setDescription(
      'Headquarters API for master menu governance, outlet assignment, API keys, sync ingestion and cross-outlet reporting. ' +
        'All responses use the `ApiSuccess`/`ApiError` envelopes; money is a decimal string of integer minor units.',
    )
    .setVersion('1.0.0')
    .addServer(`/${API_PREFIX}`, 'Current deployment')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'HQ user access token (Phase 1)' },
      'bearer-jwt',
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Machine sync credentials: `OutletKey <keyId>.<secret>` (Phase 3)',
      },
      'outlet-key',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
