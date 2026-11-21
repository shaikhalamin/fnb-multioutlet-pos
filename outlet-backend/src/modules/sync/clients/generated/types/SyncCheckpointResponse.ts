/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { SequenceRange } from './SequenceRange.js'

export type SyncCheckpointResponse = {
  /**
   * @example 61de28db-92ed-46ef-9d90-3a951ac03420
   * @type string
   */
  outletId: string;
  /**
   * @description Highest contiguous accepted sequence — decimal string.
   * @example 108
   * @type string
   */
  highestContiguousSequence: string;
  /**
   * @description Sequence ranges accepted above the watermark but not yet contiguous (reconciliation input).
   * @type array
   */
  missingRanges: SequenceRange[];
};
