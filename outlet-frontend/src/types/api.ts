/**
 * API contract types mirrored from PRD §7.1 until Kubb generation lands with
 * the first real feature contract (Phase 1; see src/api/contracts/README.md).
 */
export type ApiMeta = {
  requestId: string
  timestamp: string
  nextCursor?: string
}

export type ApiSuccess<T> = {
  data: T
  meta?: ApiMeta
}

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    requestId: string
  }
}

/** Health report served by `GET /api/v1/health`. */
export type HealthReport = {
  status: 'ok' | 'down'
  service: string
  version: string
  uptimeSeconds: number
  timestamp: string
  checks: {
    database: { status: 'up' | 'down'; reason?: string }
    redis: { status: 'up' | 'down'; reason?: string }
  }
}
