import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { SERVICE_NAME, SERVICE_VERSION } from '../../config/app.config.js';
import { DATA_SOURCE } from '../../database/database.module.js';
import { withTimeout } from '../../common/utils/async.js';
import { HEALTH_REDIS } from './health.providers.js';

export type DependencyStatus = { status: 'up' | 'down'; reason?: string };

export type HealthReport = {
  status: 'ok' | 'down';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
};

const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    @Inject(HEALTH_REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database.status === 'up' && redis.status === 'up' ? 'ok' : 'down',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.dataSource.query('SELECT 1') as Promise<unknown>, PROBE_TIMEOUT_MS, 'database probe');
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await withTimeout(this.redis.connect(), PROBE_TIMEOUT_MS, 'redis connect');
      }
      await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS, 'redis ping');
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
