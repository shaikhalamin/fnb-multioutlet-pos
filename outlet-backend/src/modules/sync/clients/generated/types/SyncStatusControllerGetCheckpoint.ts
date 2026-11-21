/* Backend-only machine client (PRD §11); never ship to a browser bundle. */

import type { SyncCheckpointResponse } from './SyncCheckpointResponse.js'

export type SyncStatusControllerGetCheckpointStatus200 = SyncCheckpointResponse;

export type SyncStatusControllerGetCheckpointStatus401 = unknown;

export type SyncStatusControllerGetCheckpointStatus403 = unknown;

export type SyncStatusControllerGetCheckpointOptions = {
  body?: never;
  path?: never;
  query?: never;
  headers?: never;
};

export type SyncStatusControllerGetCheckpointResponses = {
  '200': SyncStatusControllerGetCheckpointStatus200;
  '401': SyncStatusControllerGetCheckpointStatus401;
  '403': SyncStatusControllerGetCheckpointStatus403;
};

/**
 * @description Union of all possible responses
 */
export type SyncStatusControllerGetCheckpointResponse = SyncStatusControllerGetCheckpointStatus200;
