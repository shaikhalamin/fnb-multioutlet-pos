/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { EventBatchResult } from './EventBatchResult.js'

export type EventBatchResponse = {
  /**
   * @example 047bfdb5-727a-47eb-970a-03a038c11b92
   * @type string
   */
  batchId: string;
  results: EventBatchResult[];
  /**
   * @description Highest contiguous accepted sequence for the outlet — decimal string.
   * @example 108
   * @type string
   */
  highestContiguousSequence: string;
};
