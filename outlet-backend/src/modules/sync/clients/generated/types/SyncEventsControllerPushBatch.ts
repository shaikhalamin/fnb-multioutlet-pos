/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { EventBatchRequest } from './EventBatchRequest.js'
import type { EventBatchResponse } from './EventBatchResponse.js'

export type SyncEventsControllerPushBatchHeaders = {
  /**
   * @description Stable per logical batch attempt; preserved across retries of the same bytes (§8.5).
   * @type string
   */
  'idempotency-key': string;
};

export type SyncEventsControllerPushBatchStatus200 = EventBatchResponse;

export type SyncEventsControllerPushBatchStatus400 = unknown;

export type SyncEventsControllerPushBatchStatus401 = unknown;

export type SyncEventsControllerPushBatchStatus403 = unknown;

export type SyncEventsControllerPushBatchStatus413 = unknown;

export type SyncEventsControllerPushBatchBody = EventBatchRequest;

export type SyncEventsControllerPushBatchOptions = {
  body: SyncEventsControllerPushBatchBody;
  path?: never;
  query?: never;
  headers: SyncEventsControllerPushBatchHeaders;
};

export type SyncEventsControllerPushBatchResponses = {
  '200': SyncEventsControllerPushBatchStatus200;
  '400': SyncEventsControllerPushBatchStatus400;
  '401': SyncEventsControllerPushBatchStatus401;
  '403': SyncEventsControllerPushBatchStatus403;
  '413': SyncEventsControllerPushBatchStatus413;
};

/**
 * @description Union of all possible responses
 */
export type SyncEventsControllerPushBatchResponse = SyncEventsControllerPushBatchStatus200;
