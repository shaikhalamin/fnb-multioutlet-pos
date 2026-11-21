/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { SyncEventItemRequest } from './SyncEventItemRequest.js'

export type SyncEventDataRequest = {
  /**
   * @example 0a44e56a-628e-492a-81e0-83f4a4d68f76
   * @type string
   */
  saleId: string;
  /**
   * @example A-000001
   * @type string
   */
  receiptNo: string;
  /**
   * @description Local catalog revision — decimal string.
   * @example 42
   * @type string
   */
  catalogRevision: string;
  /**
   * @example USD
   * @type string
   */
  currencyCode: string;
  status: 'COMPLETED';
  /**
   * @example 2026-11-20T04:02:03Z
   * @type string
   */
  soldAt: string;
  /**
   * @description Minor units, canonical decimal string.
   * @example 3900
   * @type string
   */
  totalMinor: string;
  items: SyncEventItemRequest[];
};
