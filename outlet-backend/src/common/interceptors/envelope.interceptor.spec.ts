import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { EnvelopeInterceptor } from './envelope.interceptor.js';

function createContext(path: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ path }),
      getResponse: () => ({ getHeader: () => 'hdr-req' }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

/** Minimal Reflector stub: no decorator metadata anywhere. */
const reflector = {
  getAllAndOverride: () => undefined,
} as never;

describe('EnvelopeInterceptor', () => {
  it('wraps handler data in the ApiSuccess envelope with meta.requestId', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const call = { handle: () => of({ status: 'ok' }) };
    const value = (await firstValueFrom(
      interceptor.intercept(createContext('/api/v1/health'), call as never) as never,
    )) as { data: unknown; meta: Record<string, string> };

    expect(value.data).toEqual({ status: 'ok' });
    expect(value.meta.requestId).toBeTruthy();
    expect(typeof value.meta.timestamp).toBe('string');
  });

  it('passes swagger document routes through untouched', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const payload = { openapi: '3.0.3' };
    const call = { handle: () => of(payload) };
    const value = await firstValueFrom(
      interceptor.intercept(createContext('/api/v1/docs'), call as never) as never,
    );
    expect(value).toEqual(payload);
  });

  it('passes the machine-readable openapi.json route through untouched', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const payload = { openapi: '3.0.3' };
    const call = { handle: () => of(payload) };
    const value = await firstValueFrom(
      interceptor.intercept(createContext('/openapi.json'), call as never) as never,
    );
    expect(value).toEqual(payload);
  });
});
