import type { WorkerEnv } from './env.schema.js';

/**
 * Outlet → HQ synchronization configuration (PRD §14.1).
 *
 * Derived from the already-validated worker environment: the outlet worker
 * is the sole initiator of all HQ communication (menu pull, event push,
 * heartbeat) using the machine key issued by HQ. The key secret must never
 * appear in logs or frontend assets (PRD §7.4, §9.2).
 */
export type HqSyncConfig = {
  hqApiBaseUrl: string;
  /** Not secret; safe to log. */
  hqKeyId: string;
  /** Never logged. */
  hqKeySecret: string;
  outletId: string;
  outletCode: string;
  offlineGraceHours: number;
  heartbeatIntervalMs: number;
  menuPullIntervalMs: number;
  outboxBatchSize: number;
  outboxSweepIntervalMs: number;
};

/** Map the validated worker environment to the sync-worker configuration. */
export function hqSyncConfig(env: WorkerEnv): HqSyncConfig {
  return {
    hqApiBaseUrl: env.HQ_API_BASE_URL,
    hqKeyId: env.HQ_OUTLET_KEY_ID,
    hqKeySecret: env.HQ_OUTLET_KEY_SECRET,
    outletId: env.OUTLET_ID,
    outletCode: env.OUTLET_CODE,
    offlineGraceHours: env.OFFLINE_GRACE_HOURS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    menuPullIntervalMs: env.MENU_PULL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxSweepIntervalMs: env.OUTBOX_SWEEP_INTERVAL_MS,
  };
}
