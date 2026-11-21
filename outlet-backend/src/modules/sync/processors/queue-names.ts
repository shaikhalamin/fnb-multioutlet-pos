/**
 * Outlet sync queue + job names (PRD §13): four dedicated queues, jobs carry
 * event IDs only — no credentials, no payload-heavy sale details.
 */
export const QUEUES = {
  menuPull: 'menu-pull',
  outboxDispatch: 'outbox-dispatch',
  syncDelivery: 'sync-delivery',
  syncReconcile: 'sync-reconcile',
} as const;

export const JOB_NAMES = {
  pull: 'menu-pull',
  sweep: 'outbox-sweep',
  heartbeat: 'sync-heartbeat',
  deliver: 'sync-deliver',
  reconcile: 'sync-reconcile',
} as const;

/**
 * Fixed jobIds for repeatable schedulers: replicas collapse onto one
 * schedule entry (distributed singleton, PRD §13).
 */
export const REPEAT_JOB_IDS = {
  pull: 'repeat-menu-pull',
  sweep: 'repeat-outbox-sweep',
  heartbeat: 'repeat-sync-heartbeat',
  reconcile: 'repeat-sync-reconcile',
} as const;
