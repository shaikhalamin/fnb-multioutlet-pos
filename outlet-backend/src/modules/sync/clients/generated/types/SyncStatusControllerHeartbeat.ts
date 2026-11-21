/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { HeartbeatRequest } from './HeartbeatRequest.js'
import type { HeartbeatResponse } from './HeartbeatResponse.js'

export type SyncStatusControllerHeartbeatStatus200 = HeartbeatResponse;

export type SyncStatusControllerHeartbeatStatus401 = unknown;

export type SyncStatusControllerHeartbeatStatus403 = unknown;

export type SyncStatusControllerHeartbeatBody = HeartbeatRequest;

export type SyncStatusControllerHeartbeatOptions = {
  body: SyncStatusControllerHeartbeatBody;
  path?: never;
  query?: never;
  headers?: never;
};

export type SyncStatusControllerHeartbeatResponses = {
  '200': SyncStatusControllerHeartbeatStatus200;
  '401': SyncStatusControllerHeartbeatStatus401;
  '403': SyncStatusControllerHeartbeatStatus403;
};

/**
 * @description Union of all possible responses
 */
export type SyncStatusControllerHeartbeatResponse = SyncStatusControllerHeartbeatStatus200;
