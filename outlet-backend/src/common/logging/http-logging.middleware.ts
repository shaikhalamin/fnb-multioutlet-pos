import type { Request, Response } from 'express';
import { JsonLogger } from './logger.service.js';

/**
 * HTTP access log middleware (PRD §13): method, path, status, duration and
 * the request ID emitted by {@link RequestIdInterceptor}.
 */
export function httpLoggingMiddleware(
  logger: JsonLogger,
): (req: Request, res: Response, next: () => void) => void {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.log('http_request', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        requestId: res.getHeader('x-request-id'),
      });
    });
    next();
  };
}
