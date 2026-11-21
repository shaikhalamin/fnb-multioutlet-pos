/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { MenuSnapshotItem } from './MenuSnapshotItem.js'

export type MenuSnapshotResponse = {
  /**
   * @example 6f1a2c34-1b2c-4d3e-9a7b-3c4d5e6f7a8b
   * @type string
   */
  snapshotId: string;
  /**
   * @description Revision of the snapshot view — decimal string.
   * @example 42
   * @type string
   */
  snapshotRevision: string;
  items: MenuSnapshotItem[];
};
