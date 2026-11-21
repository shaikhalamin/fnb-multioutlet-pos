import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { EnvelopeInterceptor, withCursor, withMeta } from './envelope.interceptor.js';

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

  it('hoists a withCursor payload into meta.nextCursor (PRD §7.1)', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const items = withCursor([{ id: 'a' }], 'cursor-2');
    const call = { handle: () => of(items) };
    const value = (await firstValueFrom(
      interceptor.intercept(createContext('/api/v1/users'), call as never) as never,
    )) as { data: unknown; meta: Record<string, string> };

    expect(value.data).toBeTruthy();
    // The symbol key itself never serializes — JSON round-trip proves both
    // the payload shape and the no-leak guarantee.
    expect(JSON.parse(JSON.stringify(value.data))).toEqual([{ id: 'a' }]);
    expect(value.meta.nextCursor).toBe('cursor-2');
  });

  it('hoists withMeta extras into meta (catalogRevision/lastCatalogSyncAt)', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const items = withMeta([{ sku: 'BURGER-01' }], {
      catalogRevision: '42',
      lastCatalogSyncAt: '2026-11-20T04:00:00.000Z',
    });
    const call = { handle: () => of(items) };
    const value = (await firstValueFrom(
      interceptor.intercept(createContext('/api/v1/menu'), call as never) as never,
    )) as { data: unknown; meta: Record<string, string> };

    expect(JSON.parse(JSON.stringify(value.data))).toEqual([{ sku: 'BURGER-01' }]);
    expect(value.meta.catalogRevision).toBe('42');
    expect(value.meta.lastCatalogSyncAt).toBe('2026-11-20T04:00:00.000Z');
    expect(value.meta.requestId).toBeTruthy();
  });

  it('combines withCursor and withMeta on the same payload', async () => {
    const interceptor = new EnvelopeInterceptor(reflector);
    const items = withMeta(withCursor([{ id: 'a' }], 'next'), { catalogRevision: '7' });
    const call = { handle: () => of(items) };
    const value = (await firstValueFrom(
      interceptor.intercept(createContext('/api/v1/sales'), call as never) as never,
    )) as { data: unknown; meta: Record<string, string> };

    expect(value.meta.nextCursor).toBe('next');
    expect(value.meta.catalogRevision).toBe('7');
  });
});
