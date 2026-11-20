import {
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { API_PREFIX } from '../../config/app.config.js';
import { getRequestId } from '../logging/request-context.js';
import { REQUEST_ID_HEADER } from '../utils/ids.js';

export const SKIP_ENVELOPE_KEY = 'fnb:skipEnvelope';
/** Opt a route out of the ApiSuccess envelope (used for OpenAPI documents). */
export const SkipEnvelope: CustomDecorator<string> = SetMetadata(SKIP_ENVELOPE_KEY, true);

/** Symbol-keyed cursor a handler attaches via `withCursor` (invisible to JSON). */
export const PAGE_CURSOR: unique symbol = Symbol('fnb:pageCursor');

/**
 * Attaches a pagination cursor to a response payload; the envelope
 * interceptor hoists it into `meta.nextCursor` (PRD §7.1).
 */
export function withCursor<T>(data: T, nextCursor: string | undefined): T {
  if (nextCursor === undefined || (data !== null && typeof data !== 'object')) return data;
  (data as Record<symbol, unknown>)[PAGE_CURSOR] = nextCursor;
  return data;
}

/**
 * Wraps successful responses in the `ApiSuccess` envelope from PRD §7.1:
 * `{ data, meta: { requestId, timestamp, nextCursor? } }`.
 */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skipViaDecorator = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<{ path?: string; url?: string }>();
    const path = request?.path ?? request?.url ?? '';
    const isSwaggerRoute = path.startsWith(`/${API_PREFIX}/docs`) || path.startsWith('/openapi.json');
    if (skipViaDecorator || isSwaggerRoute) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        const nextCursor =
          data && typeof data === 'object' && PAGE_CURSOR in data
            ? String((data as Record<symbol, unknown>)[PAGE_CURSOR])
            : undefined;
        return {
          data: data ?? null,
          meta: {
            requestId: getRequestId() ?? this.responseRequestId(context),
            timestamp: new Date().toISOString(),
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          },
        };
      }),
    );
  }

  private responseRequestId(context: ExecutionContext): string | undefined {
    const response = context.switchToHttp().getResponse<{ getHeader?: (name: string) => unknown }>();
    const header = response.getHeader?.(REQUEST_ID_HEADER);
    return typeof header === 'string' ? header : undefined;
  }
}
