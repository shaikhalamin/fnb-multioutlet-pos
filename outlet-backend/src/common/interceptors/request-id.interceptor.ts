import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { Observable as RxObservable } from 'rxjs';
import { runWithRequestContext } from '../logging/request-context.js';
import { newRequestId, REQUEST_ID_HEADER, sanitizeRequestId } from '../utils/ids.js';

/**
 * Assigns every HTTP request a request ID (honouring a safe client-supplied
 * `X-Request-Id`), echoes it on the response and runs the whole downstream
 * pipeline inside an AsyncLocalStorage context so logs and the response
 * envelope can reference it (PRD §7, §13).
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{ headers?: Record<string, unknown> }>();
    const response = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();

    const requestId = sanitizeRequestId(request.headers?.[REQUEST_ID_HEADER]) ?? newRequestId();
    response.setHeader?.(REQUEST_ID_HEADER, requestId);

    const source = next.handle();
    // Re-enter the ALS store on subscription so handler execution (which
    // happens when Nest subscribes, outside this method) still sees it.
    return new RxObservable((subscriber) =>
      runWithRequestContext({ requestId }, () => source.subscribe(subscriber)),
    );
  }
}
