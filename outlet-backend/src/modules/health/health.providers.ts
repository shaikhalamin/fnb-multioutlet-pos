import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { healthCheckRedisOptions } from '../../config/redis.config.js';
import type { Env } from '../../config/env.schema.js';

export const HEALTH_REDIS = 'HEALTH_REDIS' as const;

/**
 * Dedicated lazy-connecting Redis client for health probes only. It never
 * retries so a down Redis fails fast instead of blocking the probe (and does
 * not interfere with the Phase 2/3 BullMQ connections).
 */
export const healthRedisProvider: Provider = {
  provide: HEALTH_REDIS,
  useFactory: (config: ConfigService<Env, true>) =>
    new Redis(config.get('REDIS_URL', { infer: true }), healthCheckRedisOptions()),
  inject: [ConfigService],
};
