import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { API_PREFIX } from '../src/config/app.config.js';
import { makeGlobalValidationPipe } from '../src/common/validation/global-validation.pipe.js';
import { DATA_SOURCE } from '../src/database/database.module.js';

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

export type E2eApp = INestApplication<App>;

/** Raw SQL against the app's live DataSource (assertions + fixtures). */
export function sql(app: E2eApp): DataSource['query'] {
  const dataSource = app.get<DataSource>(DATA_SOURCE);
  return dataSource.query.bind(dataSource);
}

/** Logs in a seeded local user and returns the bearer access token. */
export async function loginAs(
  app: E2eApp,
  email: string,
  password: string,
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(`/${API_PREFIX}/auth/login`)
    .send({ email, password })
    .expect(200);
  return response.body.data.accessToken as string;
}

/** Seeded demo credentials (overridable via SEED_OUTLET_* env, see seed.ts). */
export const SEEDED_USERS = {
  manager: {
    email: process.env.SEED_OUTLET_MANAGER_EMAIL ?? 'manager@outlet-a.local',
    password: process.env.SEED_OUTLET_MANAGER_PASSWORD ?? 'Manager123!',
  },
  cashier: {
    email: process.env.SEED_OUTLET_CASHIER_EMAIL ?? 'cashier@outlet-a.local',
    password: process.env.SEED_OUTLET_CASHIER_PASSWORD ?? 'Cashier123!',
  },
  clerk: {
    email: process.env.SEED_OUTLET_CLERK_EMAIL ?? 'clerk@outlet-a.local',
    password: process.env.SEED_OUTLET_CLERK_PASSWORD ?? 'Clerk123!',
  },
} as const;

/** Fixed demo catalog UUIDs (seed.ts) — the well-known outlet-A items. */
export const ITEM = {
  burger: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
  pizza: 'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4',
  cola: '3d0f01a2-39a6-4b6f-9d3a-6cb17b2ba110',
} as const;

/**
 * Per-run idempotency-key prefix. Fixed keys would replay the stored 201
 * responses of a previous run (correct AT-07 product behavior) and starve
 * the suite's stock/counter assertions — unique keys keep the suite
 * rerunnable against any database.
 */
const RUN_ID = randomUUID().slice(0, 8);
export function e2eKey(suffix: string): string {
  return `e2e-${RUN_ID}-${suffix}`;
}

/** Resets the demo stock to the seeded figures (e2e fixture hygiene). */
export async function resetDemoStock(app: E2eApp): Promise<void> {
  await sql(app)(
    `UPDATE inventory_balances SET quantity_on_hand = v.qty, version = 1
       FROM (VALUES
         ('${ITEM.burger}'::uuid, 50),
         ('${ITEM.pizza}'::uuid, 40),
         ('${ITEM.cola}'::uuid, 100)
       ) AS v(item_id, qty)
      WHERE inventory_balances.menu_item_id = v.item_id`,
  );
}

/**
 * Phase-2 suites sell the seeded demo items; with the Phase-3 live worker the
 * local catalog tracks HQ truth (an HQ-side e2e run may have unassigned an
 * item or changed a price). Re-asserting the seeded catalog state makes the
 * sale-semantics specs deterministic against any previously synced state —
 * the worker re-applying seed truth on its next pull is then a no-op.
 */
export async function ensureDemoCatalog(app: E2eApp): Promise<void> {
  await sql(app)(
    `INSERT INTO catalog_items (menu_item_id, assignment_id, sku, name, description, category, effective_price_minor, currency_code, active, hq_item_version, applied_revision)
     VALUES
       ('${ITEM.burger}', '31fe8f6b-02b8-409d-b1fa-6c441f422949', 'BURGER-01', 'Chicken Burger', 'Grilled chicken burger', 'Burgers', 1000, 'USD', true, 1, 1),
       ('${ITEM.pizza}', '7bbca9d3-64d1-43b0-94ab-9da64d2a2f10', 'PIZZA-01', 'Pizza', 'Margherita pizza', 'Pizza', 1500, 'USD', true, 1, 1),
       ('${ITEM.cola}', 'e5a1c9b7-92b3-45f1-8f6e-0f1a9d1c4b22', 'COLA-01', 'Cola', 'Chilled cola 330ml', 'Drinks', 300, 'USD', true, 1, 1)
     ON CONFLICT (menu_item_id) DO UPDATE SET
       effective_price_minor = EXCLUDED.effective_price_minor,
       active = true,
       updated_at = now()`,
  );
  await resetDemoStock(app);
}
