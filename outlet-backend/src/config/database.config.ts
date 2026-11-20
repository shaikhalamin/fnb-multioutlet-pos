import type { DataSourceOptions } from 'typeorm';
import { EnablePgcrypto1700000000000 } from '../database/migrations/1700000000000-enable-pgcrypto.js';

/**
 * TypeORM options shared by the runtime DI DataSource, the migration CLI and
 * the OpenAPI export path. `synchronize` stays false everywhere — schema
 * changes only land through versioned migrations (PRD §6, §14.3).
 */
export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    // Phase 1 registers HQ entities (users, outlets, menu, …).
    entities: [],
    migrations: [EnablePgcrypto1700000000000],
    synchronize: false,
    migrationsTransactionMode: 'each',
    // Deterministic, bounded connection behaviour.
    connectTimeoutMS: 5_000,
    poolSize: 10,
  };
}
