import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiException } from '../exceptions/api.exception.js';
import { GlobalExceptionFilter } from './global-exception.filter.js';

function mockHost() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const req = { headers: {}, url: '/api/v1/sales' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  return { res, req, host };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('renders a structured ApiException with its stable code and details', () => {
    const { res, host } = mockHost();
    filter.catch(new ApiException('FORBIDDEN', 'denied', 403, { scope: 'outlet' }), host as never);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('denied');
    expect(body.error.details).toEqual({ scope: 'outlet' });
    expect(body.error.requestId).toBeTruthy();
  });

  it('maps standard HTTP statuses to stable error codes', () => {
    const cases: Array<[HttpException, number, string]> = [
      [new HttpException('nope', HttpStatus.UNAUTHORIZED), 401, 'UNAUTHENTICATED'],
      [new HttpException('nope', HttpStatus.NOT_FOUND), 404, 'NOT_FOUND'],
      [new HttpException('nope', HttpStatus.TOO_MANY_REQUESTS), 429, 'RATE_LIMITED'],
    ];
    for (const [exception, status, code] of cases) {
      const { res, host } = mockHost();
      filter.catch(exception, host as never);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json.mock.calls[0][0].error.code).toBe(code);
    }
  });

  it('hides internals for unknown errors', () => {
    const { res, host } = mockHost();
    filter.catch(new Error('secret stack trace'), host as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error.');
    expect(JSON.stringify(body)).not.toContain('secret stack trace');
  });

  it('maps body-parser rejections carrying statusCode to their HTTP status, not 500', () => {
    // Shape of express body-parser's PayloadTooLargeError (`entity.too.large`):
    // a plain Error with `statusCode`/`status` set, not an HttpException.
    const tooLarge = Object.assign(new Error('request entity too large'), {
      statusCode: 413,
      status: 413,
      type: 'entity.too.large',
    });
    const { res, host } = mockHost();
    filter.catch(tooLarge, host as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.requestId).toBeTruthy();
  });

  it('maps malformed-JSON parser errors to 400 VALIDATION_FAILED', () => {
    const parseFailed = Object.assign(new Error('Unexpected token in JSON'), {
      statusCode: 400,
      type: 'entity.parse.failed',
    });
    const { res, host } = mockHost();
    filter.catch(parseFailed, host as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(res.json.mock.calls[0][0].error.code).toBe('VALIDATION_FAILED');
  });

  it('ignores non-HTTP numeric status values on unknown errors', () => {
    const { res, host } = mockHost();
    filter.catch(Object.assign(new Error('weird'), { statusCode: 'x', status: 0 }), host as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json.mock.calls[0][0].error.code).toBe('INTERNAL_ERROR');
  });

  it('always sets the X-Request-Id response header', () => {
    const { res, host } = mockHost();
    filter.catch(new Error('boom'), host as never);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', expect.any(String));
  });
});
