import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { healthRedisProvider, HEALTH_REDIS } from './health.providers.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, healthRedisProvider],
})
export class HealthModule implements OnModuleDestroy {
  constructor(@Inject(HEALTH_REDIS) private readonly healthRedis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    this.healthRedis.disconnect();
  }
}
