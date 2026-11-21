import { getAxiosInstance } from './generated/.kubb/client'
import { sessionStore } from '#/features/auth/session'
import { parseSessionUser } from '#/schemas/auth'

/** Error surfaced to callers: stable backend code + requestId when present. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function newRequestId(): string {
  return globalThis.crypto.randomUUID()
}

type EnvelopeBody = { data?: unknown; error?: EnvelopeError; meta?: unknown }
type EnvelopeError = {
  code?: string
  message?: string
  details?: Record<string, unknown>
  requestId?: string
}

function toApiError(body: EnvelopeBody | undefined, status: number): ApiError {
  const error = body?.error
  if (error?.code) {
    return new ApiError(
      error.code,
      error.message ?? 'Request failed.',
      status,
      error.details,
      error.requestId,
    )
  }
  return new ApiError(
    'INTERNAL_ERROR',
    'Unexpected response from the server.',
    status,
  )
}

/**
 * The single axios instance every generated (Kubb) client call flows through
 * (AGENTS.md §4.1): the generated runtime's own instance, configured once
 * here with envelope unwrapping, `X-Request-Id`, bearer-token injection and
 * a single-flight refresh-and-retry on 401. No other axios instance exists.
 */
export const apiClient = getAxiosInstance()

// Auth endpoints manage the session themselves; never refresh-retry them.
function isAuthPath(url: string | undefined): boolean {
  return (
    typeof url === 'string' &&
    (url.includes('/auth/login') || url.includes('/auth/refresh'))
  )
}

// Single-flight refresh: concurrent 401s share one rotation request.
let refreshInFlight: Promise<boolean> | undefined

/** Public: used by the auth gate to bootstrap the session on app load. */
export const refreshSessionNow = (): Promise<boolean> => refreshSession()

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      // Plain fetch: avoids re-entering the axios interceptor chain.
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        sessionStore.clear()
        return false
      }
      const body = (await response.json()) as {
        data?: { accessToken?: unknown; user?: unknown }
      }
      if (typeof body.data?.accessToken !== 'string') {
        sessionStore.clear()
        return false
      }
      // Parse the user with the generated schema (AGENTS §4.2); a malformed
      // payload fails the refresh rather than storing an unvalidated session.
      let user
      try {
        user = parseSessionUser(body.data.user)
      } catch {
        sessionStore.clear()
        return false
      }
      sessionStore.set({ accessToken: body.data.accessToken, user })
      return true
    } catch {
      sessionStore.clear()
      return false
    } finally {
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

apiClient.interceptors.request.use((config) => {
  // Stable per-attempt request ID (PRD §7). Retried sales must keep their
  // Idempotency-Key — that header is set per-mutation at the call site.
  config.headers.set('X-Request-Id', newRequestId())
  const { accessToken } = sessionStore.get()
  if (accessToken) {
    config.headers.set('Authorization', `Bearer ${accessToken}`)
  }
  return config
})

apiClient.interceptors.response.use(
  async (response) => {
    // The generated transport requests raw bodies (arraybuffer + identity
    // transform) and resolves every status (validateStatus: () => true), so
    // both success and error envelopes arrive here as bytes.
    const raw =
      typeof response.data === 'string'
        ? response.data
        : response.data instanceof ArrayBuffer
          ? new TextDecoder().decode(response.data)
          : response.data == null
            ? ''
            : JSON.stringify(response.data)
    let body: EnvelopeBody | undefined
    try {
      body = raw ? (JSON.parse(raw) as EnvelopeBody) : undefined
    } catch {
      body = undefined
    }
    const status = response.status

    if (status >= 400) {
      if (
        status === 401 &&
        !isAuthPath(response.config.url) &&
        !(response.config as { __retried?: boolean }).__retried
      ) {
        const refreshed = await refreshSession()
        if (refreshed) {
          ;(response.config as { __retried?: boolean }).__retried = true
          return apiClient.request(response.config)
        }
      }
      throw toApiError(body, status)
    }

    // Unwrap the ApiSuccess envelope (PRD §7.1) so generated clients — typed
    // against the bare OpenAPI payloads — resolve the DTO directly. The body
    // is re-serialized because the generated transport builds a web Response
    // from whatever bytes it finds here.
    if (body && typeof body === 'object' && 'data' in body) {
      response.data = JSON.stringify(body.data ?? null)
    }
    return response
  },
  (error: unknown) => {
    // Network-level failures (no HTTP response at all).
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ECONNABORTED'
    ) {
      return Promise.reject(new ApiError('TIMEOUT', 'The request timed out.'))
    }
    return Promise.reject(
      new ApiError(
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Network request failed.',
      ),
    )
  },
)
