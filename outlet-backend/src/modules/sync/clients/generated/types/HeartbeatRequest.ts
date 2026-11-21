/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

export type HeartbeatRequest = {
  /**
   * @description Menu revision the outlet last applied — decimal string.
   * @example 42
   * @type string
   */
  appliedMenuRevision: string;
  /**
   * @description Events awaiting delivery at the outlet.
   * @example 3
   * @type number
   */
  pendingOutboxCount: number;
  /**
   * @description Events parked for manual repair at the outlet.
   * @example 0
   * @type number
   */
  quarantinedCount: number;
  /**
   * @description Oldest undelivered event timestamp, when a backlog exists.
   * @example 2026-11-20T04:02:03.000Z
   * @type string | undefined
   */
  oldestPendingAt?: string | null;
};
