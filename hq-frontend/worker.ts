/**
 * Cloudflare Worker entry for the HQ frontend (Workers Static Assets).
 *
 * Serves the SPA from the static-assets binding and reverse-proxies /api/* to
 * the HQ backend on Railway — the Cloudflare equivalent of the Nginx
 * `/api/` proxy in this frontend's own Docker image. Keeping the browser
 * same-origin preserves the app's security model: Kubb clients call relative
 * `/api/v1/...` paths, the `hq_rt` refresh cookie stays `SameSite=Lax`, and
 * no CORS configuration is needed (PRD §11, §9.1).
 *
 * `BACKEND_ORIGIN` (origin only, no trailing slash) comes from wrangler.jsonc
 * `vars` (overridable in the dashboard), e.g.
 * https://fnb-pos-hq-backend-production.up.railway.app
 */

interface Env {
  BACKEND_ORIGIN?: string;
  /** Static-assets binding (Fetch-like; minimal local typing). */
  ASSETS: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

const proxyError = (): Response =>
  new Response(
    JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'API proxy is not configured (BACKEND_ORIGIN is not set).',
        requestId: 'hq-web-worker',
      },
    }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Static assets are matched before the Worker runs; anything else that is
    // not an API call falls back through ASSETS (SPA index.html via
    // not_found_handling in wrangler.jsonc).
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const origin = (env.BACKEND_ORIGIN ?? '').replace(/\/+$/, '');
    if (!origin) {
      return proxyError();
    }

    const upstream = await fetch(origin + url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      // Buffered rather than streamed: request bodies are bounded (sync event
      // batches are capped at SYNC_MAX_BODY_BYTES, default 1 MiB), and an
      // ArrayBuffer body sidesteps stream/duplex runtime quirks entirely.
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });

    const headers = new Headers(upstream.headers);
    // Set-Cookie is a multi-value header: it must be copied explicitly or the
    // refresh cookie set by /auth/login|refresh is dropped at the proxy hop.
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) {
      headers.delete('Set-Cookie');
      for (const cookie of cookies) {
        headers.append('Set-Cookie', cookie);
      }
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  },
} satisfies { fetch(request: Request, env: Env): Promise<Response> };
