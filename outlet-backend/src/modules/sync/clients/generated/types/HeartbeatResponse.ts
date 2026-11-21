/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

export type HeartbeatResponse = {
  /**
   * @example 2026-11-20T04:02:10.000Z
   * @type string
   */
  acknowledgedAt: string;
};
