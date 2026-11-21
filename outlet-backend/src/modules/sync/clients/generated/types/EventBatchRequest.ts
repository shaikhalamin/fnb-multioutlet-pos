/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { SyncEventV1 } from './SyncEventV1.js'

export type EventBatchRequest = {
  /**
   * @example 047bfdb5-727a-47eb-970a-03a038c11b92
   * @type string
   */
  batchId: string;
  events: SyncEventV1[];
};
