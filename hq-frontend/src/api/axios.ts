import axios from 'axios'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { env } from '#/lib/env'
import type { ApiErrorBody, ApiMeta, ApiSuccess } from '#/types/api'

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

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (axios.isAxiosError<ApiErrorBody>(error)) {
    const body = error.response?.data.error
    if (body) {
      return new ApiError(
        body.code,
        body.message,
        error.response?.status,
        body.details,
        body.requestId,
      )
    }
    if (error.code === 'ECONNABORTED') {
      return new ApiError('TIMEOUT', 'The request timed out.')
    }
  }
  return new ApiError(
    'NETWORK_ERROR',
    error instanceof Error ? error.message : 'Network request failed.',
  )
}

/** Result of an unwrapped API call: envelope data + response meta. */
export type ApiResult<T> = { data: T; meta?: ApiMeta }

export const apiClient = axios.create({
  baseURL: env.VITE_API_BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  // Stable per-attempt request ID; retried sales must reuse their
  // Idempotency-Key instead (PRD §7.3, Phase 2).
  config.headers.set('X-Request-Id', newRequestId())
  return config
})

apiClient.interceptors.response.use(
  (response: AxiosResponse<ApiSuccess<unknown>>) => {
    // Unwrap the ApiSuccess envelope (PRD §7.1).
    const { data, meta } = response.data
    response.data = { data, meta } satisfies ApiResult<unknown>
    return response
  },
  (error: unknown) => Promise.reject(toApiError(error)),
)

/** Typed GET returning unwrapped envelope data. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const response = await apiClient.get<ApiResult<T>>(path)
  return response.data
}

export { toApiError }
