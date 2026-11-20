import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '../config/app.config.js';

/**
 * Builds the machine-readable Outlet API contract (PRD §7). The exported JSON
 * artifact (`openapi/openapi.json`, regenerated via `pnpm openapi:export`) is the input for the
 * Kubb client generation pipeline in `outlet-frontend` (PRD §11).
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('F&B Platform — Outlet API')
    .setDescription(
      'Outlet POS API for the locally assigned catalog, inventory, atomic multi-item sales and receipts. ' +
        'Runs at the outlet site against its own PostgreSQL; sales never depend on HQ reachability. ' +
        'All responses use the `ApiSuccess`/`ApiError` envelopes; money is a decimal string of integer minor units.',
    )
    .setVersion('1.0.0')
    .addServer(`/${API_PREFIX}`, 'Current deployment')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Outlet user access token (Phase 2)' },
      'bearer-jwt',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
