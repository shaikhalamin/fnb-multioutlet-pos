import type { DataSourceOptions } from 'typeorm';
import { outletEntities } from '../database/entities/index.js';
import { EnablePgcrypto1700000000000 } from '../database/migrations/1700000000000-enable-pgcrypto.js';
import { OutletPhase2Core1720000000000 } from '../database/migrations/1720000000000-outlet-phase2-core.js';
import { OutletPhase3Sync1730000000000 } from '../database/migrations/1730000000000-outlet-phase3-sync.js';
import { OutletPhase4Setup1740000000000 } from '../database/migrations/1740000000000-outlet-phase4-setup.js';

/**
 * TypeORM options shared by the runtime DI DataSource, the migration CLI and
 * the OpenAPI export path. `synchronize` stays false everywhere — schema
 * changes only land through versioned migrations (PRD §6, §14.3).
 */
export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    // Phase 2 registers outlet entities (users, catalog cache, inventory,
    // sales, outbox, …).
    entities: outletEntities,
    migrations: [
      EnablePgcrypto1700000000000,
      OutletPhase2Core1720000000000,
      OutletPhase3Sync1730000000000,
      OutletPhase4Setup1740000000000,
    ],
    synchronize: false,
    migrationsTransactionMode: 'each',
    // Deterministic, bounded connection behaviour.
    connectTimeoutMS: 5_000,
    poolSize: 10,
  };
}
