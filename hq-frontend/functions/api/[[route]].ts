/**
 * Cloudflare Pages Function: reverse-proxy /api/* to the HQ backend on
 * Railway — the Cloudflare equivalent of the Nginx `/api/` proxy in this
 * frontend's own Docker image. Keeping the browser same-origin preserves
 * the app's existing security model: Kubb clients call relative
 * `/api/v1/...` paths, the `hq_rt` refresh cookie stays `SameSite=Lax`,
 * and no CORS configuration is needed (PRD §11, §9.1).
 *
 * Configure `BACKEND_ORIGIN` (Pages env var, origin only, no trailing
 * slash), e.g. https://fnb-pos-hq-backend-production.up.railway.app
 */

/** Minimal Pages Function context — avoids a @cloudflare/workers-types dep. */
interface PagesFunctionContext {
  request: Request;
  env: { BACKEND_ORIGIN?: string };
}

export const onRequest = async ({ request, env }: PagesFunctionContext): Promise<Response> => {
  const origin = (env.BACKEND_ORIGIN ?? '').replace(/\/+$/, '');
  if (!origin) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'API proxy is not configured (BACKEND_ORIGIN is not set).',
          requestId: 'pages-function',
        },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const url = new URL(request.url);
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
};
