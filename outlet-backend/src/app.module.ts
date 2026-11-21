import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { JwtAuthGuard } from './common/rbac/jwt-auth.guard.js';
import { httpLoggingMiddleware } from './common/logging/http-logging.middleware.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { ConfigurationModule } from './config/configuration.module.js';
import type { Env } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { MenuCacheModule } from './modules/menu-cache/menu-cache.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  // ConfigurationModule first: every other module reads ConfigService<Env, true>.
  imports: [
    ConfigurationModule,
    // Global rate limiting: 100 requests/minute per client IP by default
    // (env-tunable for perf runs, PRD §16). Tighter per-route budgets are
    // set with @Throttle (e.g. outlet login).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        {
          ttl: config.get('THROTTLE_TTL_MS', { infer: true }),
          limit: config.get('THROTTLE_LIMIT', { infer: true }),
        },
      ],
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    UsersModule,
    MenuCacheModule,
    InventoryModule,
    SalesModule,
    SyncModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // Order matters: RequestId (outermost) enters the ALS store that the
    // Envelope interceptor and logger read.
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    // Rate limiting runs before authentication so floods are rejected cheap.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    const accessLogger = new JsonLogger('HTTP');
    consumer.apply(httpLoggingMiddleware(accessLogger)).forRoutes('{*splat}');
  }
}
