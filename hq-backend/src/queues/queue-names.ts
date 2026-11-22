/**
 * HQ background queue + job names (PRD §13). Catalog fan-out deliberately has
 * NO queue: menu mutations commit their per-outlet distribution records in
 * the same PostgreSQL transaction (AGENTS.md "one transaction" rule) and
 * outlets pull the changes themselves — HQ never pushes to outlets.
 */
export const QUEUES = {
  auditCleanup: 'audit-cleanup',
} as const;

export const JOB_NAMES = {
  auditCleanup: 'audit-cleanup-sweep',
} as const;

/**
 * Fixed jobIds for repeatable schedulers: replicas collapse onto one
 * schedule entry (distributed singleton, PRD §13).
 */
export const REPEAT_JOB_IDS = {
  auditCleanup: 'repeat-audit-cleanup',
} as const;
