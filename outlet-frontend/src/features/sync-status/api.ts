import { syncControllerGetStatus } from '#/api/generated/clients/syncControllerGetStatus'
import { syncStatusResponseSchema } from '#/api/generated/schemas/syncStatusResponseSchema'

export type SyncStatus = {
  outletId: string
  outletCode: string
  lastAppliedRevision: string
  lastMenuSyncAt: string | null
  grace: { hours: number; expiresAt: string | null; expired: boolean }
  outbox: {
    pendingCount: number
    quarantinedCount: number
    oldestPendingAt: string | null
    lastPublishedAt: string | null
  }
}

/** `GET /sync/status` — purely local; a down HQ never affects it (PRD §2). */
export async function fetchSyncStatus(): Promise<SyncStatus> {
  const data = await syncControllerGetStatus()
  return syncStatusResponseSchema.parse(data)
}
