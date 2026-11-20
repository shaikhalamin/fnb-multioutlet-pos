import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ENV_FILE_PATHS, validateEnv } from './env.schema.js';

/**
 * Typed configuration access for the whole application. Both entrypoints —
 * the HTTP API (`src/main.ts`) and the sync worker (`src/worker-main.ts`) —
 * share this module: it loads `.env.local`/`.env` for local development,
 * validates the merged environment with the Zod schema (entrypoint-profile
 * aware) and exposes the result through `ConfigService<Env, true>` with
 * `infer: true` access. Missing or inconsistent critical values fail startup
 * (PRD §14.1).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ENV_FILE_PATHS,
    }),
  ],
})
export class ConfigurationModule {}
