import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Runtime-validated environment (PRD §14.1): missing or inconsistent critical
 * values fail startup with a structured fatal log instead of surfacing later
 * as undefined behaviour.
 *
 * The schema is the superset understood by both HQ entrypoints (`api`,
 * `worker`). Profile-specific secrets are optional in the base schema and
 * enforced by `apiEnvSchema`/`workerEnvSchema`, so the worker never has to be
 * provisioned with API signing keys — its machine identity comes later from
 * the outlet key flow, not HQ JWTs (PRD §3) — while the API never needs
 * worker-only credentials.
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

/**
 * HS256 signing secrets (PRD §9.1): one for access tokens, one for refresh
 * tokens, so compromising either never forges the other kind. 32+ chars is
 * the floor for a symmetric secret used with HS256.
 */
const jwtSecret = z.string().min(32);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  // API profile: human JWT issuance + outlet key hashing (Phase 1).
  HQ_JWT_ISSUER: z.string().min(1).optional(),
  HQ_JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: jwtSecret.optional(),
  JWT_REFRESH_SECRET: jwtSecret.optional(),
  OUTLET_KEY_PEPPER: z.string().min(1).optional(),

  ACCESS_TOKEN_TTL: positiveInt.default(900),
  REFRESH_TOKEN_TTL: positiveInt.default(1_209_600),
  SYNC_MAX_BODY_BYTES: positiveInt.default(1_048_576),

  /** Rotation overlap window for outlet API keys in hours (PRD §9.2). */
  KEY_ROTATION_GRACE_HOURS: positiveInt.default(24),

  /**
   * Explicit override for the refresh cookie `Secure` flag. The local dev
   * cluster terminates plain HTTP inside Compose, so it sets `false`;
   * default is `true` only in production (PRD §9.1).
   */
  REFRESH_COOKIE_SECURE: z.enum(['true', 'false']).optional().transform((value) =>
    value === undefined ? undefined : value === 'true',
  ),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean)),

  SWAGGER_ENABLED: booleanFlag,
  /** Set by the OpenAPI export script: boot the module graph without I/O. */
  OPENAPI_EXPORT: booleanFlag,

  // Worker profile.
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Audit-trail retention window in days (worker profile). `0` (default)
   * disables deletion — the trail is immutable out of the box; a positive
   * value makes the hourly worker timer delete rows older than the cutoff in
   * bounded batches (FR-10).
   */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof envSchema>;

/** Turns the listed optional keys into required, non-undefined keys. */
type WithRequired<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

/** Secrets the HTTP API requires; enforced by `apiEnvSchema`. */
const API_REQUIRED = [
  'HQ_JWT_ISSUER',
  'HQ_JWT_AUDIENCE',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'OUTLET_KEY_PEPPER',
] as const satisfies ReadonlyArray<keyof Env>;

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
  if (env.REFRESH_TOKEN_TTL <= env.ACCESS_TOKEN_TTL) {
    ctx.addIssue({
      code: 'custom',
      path: ['REFRESH_TOKEN_TTL'],
      message: `must be greater than ACCESS_TOKEN_TTL (${env.ACCESS_TOKEN_TTL}s)`,
    });
  }
});

export type ApiEnv = WithRequired<Env, (typeof API_REQUIRED)[number]>;

/**
 * Environment contract of the worker entrypoint (`src/worker-main.ts`). The
 * HQ worker runs the same compiled module graph but never issues human JWTs,
 * so it requires nothing beyond the base schema (PRD §3).
 */
export const workerEnvSchema = envSchema;

export type WorkerEnv = Env;

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

/** Test/tooling hook: apply the same env-file precedence before placeholders. */
export { loadEnvFileGaps };

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
      `Invalid hq-backend environment configuration (${currentProfile()} entrypoint):\n` +
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
        service: 'hq-backend',
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
        service: 'hq-backend',
        msg: 'Invalid database environment',
        issues: result.issues,
      })}\n`,
    );
    process.exit(1);
  }
  return result.env;
}
