import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../config/database.config.js';
import { parseDatabaseEnv } from '../config/env.schema.js';

/**
 * CLI DataSource for the migration pipeline (PRD §14.3). Mirrors the runtime
 * options in `database.config.ts`; migrations are the only schema authority.
 * Uses the reduced migration-only environment schema (DATABASE_URL alone).
 */
export function buildCliDataSource(): DataSource {
  const env = parseDatabaseEnv();
  return new DataSource(buildDataSourceOptions(env.DATABASE_URL));
}
