import type { WorkerEnv } from './env.schema.js';

/**
 * Outlet → HQ synchronization configuration (PRD §14.1).
 *
 * Cadence/limits come from the validated worker environment; the HQ
 * credentials DO NOT: the worker is the sole initiator of all HQ
 * communication (menu pull, event push, heartbeat), and it authenticates
 * with the machine key stored in the `hq_connection` row (setup wizard /
 * rotation surface). The key secret never appears in environment
 * variables, logs or frontend assets (PRD §7.4, §9.2).
 */
export type HqSyncConfig = {
  offlineGraceHours: number;
  heartbeatIntervalMs: number;
  menuPullIntervalMs: number;
  outboxBatchSize: number;
  outboxSweepIntervalMs: number;
};

/** Map the validated worker environment to the sync-worker configuration. */
export function hqSyncConfig(env: WorkerEnv): HqSyncConfig {
  return {
    offlineGraceHours: env.OFFLINE_GRACE_HOURS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    menuPullIntervalMs: env.MENU_PULL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxSweepIntervalMs: env.OUTBOX_SWEEP_INTERVAL_MS,
  };
}
