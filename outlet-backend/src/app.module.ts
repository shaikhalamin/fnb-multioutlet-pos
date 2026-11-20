import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor.js';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { httpLoggingMiddleware } from './common/logging/http-logging.middleware.js';
import { JsonLogger } from './common/logging/logger.service.js';
import { ConfigurationModule } from './config/configuration.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  // ConfigurationModule first: every other module reads ConfigService<Env, true>.
  imports: [
    ConfigurationModule,
    // Global rate limiting: 100 requests/minute per client IP. Tighter
    // per-route budgets are set with @Throttle (e.g. future outlet login).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // Order matters: RequestId (outermost) enters the ALS store that the
    // Envelope interceptor and logger read.
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    const accessLogger = new JsonLogger('HTTP');
    consumer.apply(httpLoggingMiddleware(accessLogger)).forRoutes('{*splat}');
  }
}
