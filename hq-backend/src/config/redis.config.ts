import type { RedisOptions } from 'ioredis';

/**
 * Redis connection options derived from REDIS_URL (PRD §14.1).
 *
 * Phase 0 uses short-lived health probes only; BullMQ workers (Phase 2/3)
 * will reuse this URL with their own connection settings.
 */
export type RedisConfig = {
  url: string;
};

export function loadRedisConfig(redisUrl: string): RedisConfig {
  return { url: redisUrl };
}

/** Options for an ad-hoc health-check client: never retry, fail fast. */
export function healthCheckRedisOptions(): RedisOptions {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
}
