import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../config/database.config.js';
import { ConfigurationModule } from '../config/configuration.module.js';
import type { Env } from '../config/env.schema.js';

export const DATA_SOURCE = 'DATA_SOURCE' as const;

const dataSourceFactory: Provider = {
  provide: DATA_SOURCE,
  // Config access pattern: typed ConfigService<Env, true> with infer, as in
  // ConfigurationModule. A custom provider (instead of
  // TypeOrmModule.forRootAsync) keeps initialization explicit: the OpenAPI
  // export path boots this exact module graph without any database I/O.
  useFactory: (config: ConfigService<Env, true>) =>
    new DataSource(buildDataSourceOptions(config.get('DATABASE_URL', { infer: true }))),
  inject: [ConfigService],
};

/**
 * Owns the runtime PostgreSQL connection (PRD §6, §14). `synchronize` is
 * always false — schema changes only land via migrations. Global: the
 * DataSource is a process-wide singleton every feature module shares.
 */
@Global()
@Module({
  imports: [ConfigurationModule],
  providers: [dataSourceFactory],
  exports: [DATA_SOURCE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Fail startup when the database is unreachable (except doc exports). */
  async onModuleInit(): Promise<void> {
    if (this.config.get('OPENAPI_EXPORT', { infer: true })) return;
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
