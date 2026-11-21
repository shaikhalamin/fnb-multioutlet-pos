import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { JsonLogger } from '../logging/logger.service.js';
import { getRequestId } from '../logging/request-context.js';
import { newRequestId, REQUEST_ID_HEADER, sanitizeRequestId } from '../utils/ids.js';

interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const STATUS_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

/**
 * Renders every error as the `ApiError` envelope from PRD §7.1/§12 with a
 * stable `code` and the request ID; never leaks internals for 5xx errors.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new JsonLogger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const requestId =
      getRequestId() ??
      sanitizeRequestId(request?.headers?.[REQUEST_ID_HEADER]) ??
      newRequestId();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const normalized = this.normalize(exception);

    if (normalized.status >= 500) {
      this.logger.error('unhandled_exception', exception instanceof Error ? exception.stack : exception, {
        requestId,
        code: normalized.code,
        path: request?.url,
      });
    } else {
      this.logger.warn('request_failed', { requestId, code: normalized.code, status: normalized.status, path: request?.url });
    }

    response.status(normalized.status).json({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        requestId,
      },
    });
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: {
          errors: exception.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string') {
        const payload = body as { code: string; message?: unknown; details?: unknown };
        return {
          status,
          code: payload.code,
          message: typeof payload.message === 'string' ? payload.message : exception.message,
          ...(typeof payload.details === 'object' && payload.details !== null
            ? { details: payload.details as Record<string, unknown> }
            : {}),
        };
      }
      return {
        status,
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        message: exception.message,
      };
    }

    const expressStatus = expressErrorStatus(exception);
    if (expressStatus !== undefined) {
      return {
        status: expressStatus,
        code: STATUS_CODES[expressStatus] ?? (expressStatus >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
        message: exception instanceof Error ? exception.message : 'Request error.',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    };
  }
}

/**
 * Express-style errors — body-parser rejections (e.g. the JSON size limit's
 * `entity.too.large`) and `http-errors` — are plain `Error`s carrying a
 * numeric `statusCode`/`status`, not `HttpException`s. Without this branch a
 * body over `SYNC_MAX_BODY_BYTES` would surface as 500 `INTERNAL_ERROR`
 * instead of the contractual 413 (PRD §8.5).
 */
function expressErrorStatus(exception: unknown): number | undefined {
  if (!(exception instanceof Error) || exception instanceof HttpException) return undefined;
  const candidate =
    (exception as { statusCode?: unknown }).statusCode ?? (exception as { status?: unknown }).status;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : undefined;
}
