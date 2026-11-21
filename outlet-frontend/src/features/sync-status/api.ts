import { syncControllerExtendGrace } from '#/api/generated/clients/syncControllerExtendGrace'
import { syncControllerGetStatus } from '#/api/generated/clients/syncControllerGetStatus'
import { syncControllerReplayEvent } from '#/api/generated/clients/syncControllerReplayEvent'
import { graceOverrideResponseSchema } from '#/api/generated/schemas/graceOverrideResponseSchema'
import { replayOutboxEventResponseSchema } from '#/api/generated/schemas/replayOutboxEventResponseSchema'
import { syncStatusResponseSchema } from '#/api/generated/schemas/syncStatusResponseSchema'

export type SyncStatus = {
  outletId: string
  outletCode: string
  lastAppliedRevision: string
  lastMenuSyncAt: string | null
  grace: {
    hours: number
    expiresAt: string | null
    expired: boolean
    override: {
      active: boolean
      until: string
      reason: string
      overriddenBy: string
    } | null
  }
  outbox: {
    pendingCount: number
    quarantinedCount: number
    oldestPendingAt: string | null
    lastPublishedAt: string | null
    lastErrorSample: Array<{
      eventId: string
      sequenceNo: string
      lastError: string | null
    }> | null
  }
}

/** `GET /sync/status` — purely local; a down HQ never affects it (PRD §2). */
export async function fetchSyncStatus(): Promise<SyncStatus> {
  const data = await syncControllerGetStatus()
  const parsed = syncStatusResponseSchema.parse(data)
  // Normalize optional nullish fields to plain `| null` for consumers.
  return {
    ...parsed,
    grace: { ...parsed.grace, override: parsed.grace.override ?? null },
    outbox: {
      ...parsed.outbox,
      lastErrorSample: parsed.outbox.lastErrorSample ?? null,
    },
  }
}

/**
 * `POST /sync/grace-override` (PRD §8.8): privileged + audited manager
 * action. The backend re-validates bounds (1–72h, reason length) — the form
 * schema is UX only (AGENTS §4.2).
 */
export async function extendGrace(input: {
  hours: number
  reason: string
}): Promise<{ until: string; hours: number }> {
  const data = await syncControllerExtendGrace({
    body: input,
    throwOnError: true,
  })
  return graceOverrideResponseSchema.parse(data)
}

/** `POST /sync/outbox/:eventId/replay` — manual repair of a quarantined event (§8.5). */
export async function replayQuarantinedEvent(
  eventId: string,
): Promise<{ eventId: string; status: string }> {
  const data = await syncControllerReplayEvent({
    path: { eventId },
    throwOnError: true,
  })
  return replayOutboxEventResponseSchema.parse(data)
}
