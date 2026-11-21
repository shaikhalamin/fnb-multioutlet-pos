import type { DataSourceOptions } from 'typeorm';
import { hqEntities } from '../database/entities/index.js';
import { EnablePgcrypto1700000000000 } from '../database/migrations/1700000000000-enable-pgcrypto.js';
import { HqPhase1Core1710000000000 } from '../database/migrations/1710000000000-hq-phase1-core.js';
import { HqPhase3Sync1730000000000 } from '../database/migrations/1730000000000-hq-phase3-sync.js';

/**
 * TypeORM options shared by the runtime DI DataSource, the migration CLI and
 * the OpenAPI export path. `synchronize` stays false everywhere — schema
 * changes only land through versioned migrations (PRD §6, §14.3).
 */
export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: hqEntities,
    migrations: [EnablePgcrypto1700000000000, HqPhase1Core1710000000000, HqPhase3Sync1730000000000],
    synchronize: false,
    migrationsTransactionMode: 'each',
    // Deterministic, bounded connection behaviour.
    connectTimeoutMS: 5_000,
    poolSize: 10,
  };
}

