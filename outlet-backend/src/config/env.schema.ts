import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Runtime-validated environment (PRD §14.1): missing or inconsistent critical
 * values fail startup with a structured fatal log instead of surfacing later
 * as undefined behaviour.
 *
 * The schema is the superset understood by both outlet entrypoints (`api`,
 * `worker`). Profile-specific secrets are optional in the base schema and
 * enforced by `apiEnvSchema`/`workerEnvSchema`: the outlet API issues human
 * JWTs but never talks to HQ, while the worker authenticates with the HQ
 * machine key and never issues outlet user JWTs (PRD §3, §9.2) — so neither
 * entrypoint can be accidentally provisioned with the other's credentials.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Accepts "true"/"false"/"1"/"0" from Compose-style environments. */
const booleanFlag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const postgresUrl = z
  .url()
  .refine((value) => value.startsWith('postgres'), { message: 'must be a postgres:// or postgresql:// URL' });
const redisUrl = z
  .url()
  .refine((value) => value.startsWith('redis'), { message: 'must be a redis:// or rediss:// URL' });
const httpUrl = z
  .url()
  .refine((value) => value.startsWith('http'), { message: 'must be an http:// or https:// URL' });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  // Outlet identity is provisioned (PRD §6.2) and immutable locally; both
  // entrypoints need it to scope every query and event to this outlet.
  OUTLET_ID: z.uuid(),
  OUTLET_CODE: z.string().min(1).max(8),

  // API profile: outlet user JWT issuance (Phase 2).
  OUTLET_JWT_ISSUER: z.string().min(1).optional(),
  OUTLET_JWT_AUDIENCE: z.string().min(1).optional(),
  OUTLET_JWT_ACCESS_SECRET: z.string().min(32).optional(),
  OUTLET_JWT_REFRESH_SECRET: z.string().min(32).optional(),

  // Offline sales grace period in hours (PRD §8.8, proposed 72h).
  OFFLINE_GRACE_HOURS: positiveInt.default(72),
  SYNC_MAX_BODY_BYTES: positiveInt.default(1_048_576),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean)),

  SWAGGER_ENABLED: booleanFlag,
  /** Set by the OpenAPI export script: boot the module graph without I/O. */
  OPENAPI_EXPORT: booleanFlag,

  // Worker profile: outlet-initiated HQ synchronization (PRD §8, §9.2). The
  // key secret is server-side only and must never reach any frontend.
  HQ_API_BASE_URL: httpUrl.optional(),
  HQ_OUTLET_KEY_ID: z.string().min(1).optional(),
  HQ_OUTLET_KEY_SECRET: z.string().min(1).optional(),

  MENU_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

/** Turns the listed optional keys into required, non-undefined keys. */
type WithRequired<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

/** Secrets the HTTP API requires; enforced by `apiEnvSchema`. */
const API_REQUIRED = [
  'OUTLET_JWT_ISSUER',
  'OUTLET_JWT_AUDIENCE',
  'OUTLET_JWT_ACCESS_SECRET',
  'OUTLET_JWT_REFRESH_SECRET',
] as const satisfies ReadonlyArray<keyof Env>;

/** HQ machine credentials the sync worker requires; enforced by `workerEnvSchema`. */
const WORKER_REQUIRED = ['HQ_API_BASE_URL', 'HQ_OUTLET_KEY_ID', 'HQ_OUTLET_KEY_SECRET'] as const satisfies ReadonlyArray<keyof Env>;

function requireForProfile(ctx: z.RefinementCtx, env: Env, keys: ReadonlyArray<keyof Env>): void {
  for (const key of keys) {
    if (env[key] === undefined || env[key] === '') {
      ctx.addIssue({ code: 'custom', path: [key], message: 'is required for this entrypoint' });
    }
  }
}

/** Environment contract of the HTTP API entrypoint (`src/main.ts`). */
export const apiEnvSchema = envSchema.superRefine((env, ctx) => {
  requireForProfile(ctx, env, API_REQUIRED);
});

export type ApiEnv = WithRequired<Env, (typeof API_REQUIRED)[number]>;

/**
 * Environment contract of the sync worker entrypoint (`src/worker-main.ts`):
 * the worker is the sole initiator of all HQ communication using the machine
 * key and never issues outlet user JWTs, so it requires the HQ sync
 * credentials instead of the API auth secrets (PRD §3, §9.2).
 */
export const workerEnvSchema = envSchema.superRefine((env, ctx) => {
  requireForProfile(ctx, env, WORKER_REQUIRED);
});

export type WorkerEnv = WithRequired<Env, (typeof WORKER_REQUIRED)[number]>;

/** Slice needed by the migration CLI/job, which touches only the database. */
export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export type EnvParseResult<T> =
  | { ok: true; env: T }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export function safeParseEnv<T>(schema: z.ZodType<T>, source: Record<string, unknown>): EnvParseResult<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/**
 * Env-file precedence for local development: real environment variables
 * always win, then `.env.local`, then `.env` (first file wins on conflicts —
 * the same precedence `@nestjs/config` applies in `ConfigurationModule`).
 */
export const ENV_FILE_PATHS = ['.env.local', '.env'];

function loadDotEnvFile(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return; // no such file — rely on the real environment
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadEnvFileGaps(): void {
  for (const path of ENV_FILE_PATHS) {
    loadDotEnvFile(path);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export type EntrypointProfile = 'api' | 'worker';

/**
 * Which entrypoint this process runs. Set explicitly by the entrypoint
 * scripts (`parseApiEnv`/`parseWorkerEnv`), by Compose and by the worker
 * npm script; the default is the HTTP API.
 */
export function currentProfile(): EntrypointProfile {
  return process.env.APP_ENTRYPOINT === 'worker' ? 'worker' : 'api';
}

/**
 * `ConfigModule` validation hook: receives the merged environment (process
 * env first, then the env files) and returns the parsed, typed configuration
 * that backs `ConfigService<Env, true>` throughout the DI container. Invalid
 * configuration throws and fails application startup (PRD §14.1).
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const schema = currentProfile() === 'worker' ? workerEnvSchema : apiEnvSchema;
  const result = safeParseEnv(schema, config);
  if (!result.ok) {
    throw new Error(
      `Invalid outlet-backend environment configuration (${currentProfile()} entrypoint):\n` +
        result.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
  }
  return result.env;
}

let cachedEnv: Env | undefined;

/** Parse (once) and memoize the validated environment; exits on failure. */
function parseEntrypointEnv(profile: EntrypointProfile, fatalMsg: string): Env {
  if (cachedEnv !== undefined) return cachedEnv;
  // Pin the profile before the Nest module graph boots so `validateEnv`
  // (and therefore `ConfigurationModule`) validates the same contract.
  process.env.APP_ENTRYPOINT = profile;
  loadEnvFileGaps();
  const schema = profile === 'worker' ? workerEnvSchema : apiEnvSchema;
  const result = safeParseEnv(schema, process.env);
  if (!result.ok) {
    // Structured fatal output before the logger exists.
    process.stderr.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: 'fatal',
        service: 'outlet-backend',
        msg: fatalMsg,
        issues: result.issues,
      })}\n`,
    );
    process.exit(1);
  }
  cachedEnv = result.env;
  return result.env;
}

/** API entrypoint environment (`src/main.ts`); exits on failure. */
export function parseApiEnv(): ApiEnv {
  return parseEntrypointEnv('api', 'Invalid environment configuration') as ApiEnv;
}

/** Worker entrypoint environment (`src/worker-main.ts`); exits on failure. */
export function parseWorkerEnv(): WorkerEnv {
  return parseEntrypointEnv('worker', 'Invalid worker environment configuration') as WorkerEnv;
}

/** Migration CLI environment (DATABASE_URL only); exits on failure. */
export function parseDatabaseEnv(): DatabaseEnv {
  loadEnvFileGaps();
  const result = safeParseEnv(databaseEnvSchema, process.env);
  if (!result.ok) {
    process.stderr.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: 'fatal',
        service: 'outlet-backend',
        msg: 'Invalid database environment',
        issues: result.issues,
      })}\n`,
    );
    process.exit(1);
  }
  return result.env;
}
